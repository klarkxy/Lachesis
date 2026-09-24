import type { DshAcpExecutor, ExecutorOptions, RunHandle, RunSpec, RuntimeReadiness } from './types.ts'
import { SubprocessHost } from './subprocess.ts'
import { AcpRun } from './run.ts'
import { finiteTimeout, withDeadline } from './deadline.ts'
import { checkToolReadiness, readinessIdentity } from './readiness.ts'
import { RangeExitUnconfirmedError, RuntimeEnvironmentError } from './errors.ts'

export class DshAcpRuntime implements DshAcpExecutor {
  private readonly options: ExecutorOptions
  private readonly host = new SubprocessHost()
  private readonly live = new Map<string, RunHandle>()
  private exitBound = false
  private closing = false
  private generation = 0
  private closeAllPromise: Promise<void> | undefined
  private readonly readinessReceipts = new Map<string, { identity: string; at: number }>()
  private readonly readinessChecks = new Set<Promise<RuntimeReadiness>>()
  private readinessRangeUnconfirmed = false

  constructor(options: ExecutorOptions = {}) {
    this.options = {
      ...options,
      startupTimeoutMs: finiteTimeout('startupTimeoutMs', options.startupTimeoutMs, 120_000),
      promptTimeoutMs: finiteTimeout('promptTimeoutMs', options.promptTimeoutMs, 30 * 60_000),
      closeTimeoutMs: finiteTimeout('closeTimeoutMs', options.closeTimeoutMs, 5_000),
      disposeGraceMs: finiteTimeout('disposeGraceMs', options.disposeGraceMs, 3_000),
      disposeEofGraceMs: finiteTimeout('disposeEofGraceMs', options.disposeEofGraceMs, 6_000),
      disposeTimeoutMs: finiteTimeout('disposeTimeoutMs', options.disposeTimeoutMs, (options.disposeGraceMs ?? 3_000) + 10_000),
    }
    if (options.bindProcessExit !== false) this.bindExit()
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    if (this.closing) throw new Error('executor is closing')
    const generation = this.generation
    // An explicit command is the existing trusted fixture/custom-transport seam.
    // Production uses the bundled dsh command and cannot skip a failed probe.
    if (spec.command === undefined) {
      const key = this.readinessKey(spec)
      const receipt = this.readinessReceipts.get(key)
      this.readinessReceipts.delete(key)
      const valid = receipt && Date.now() - receipt.at < 30_000 && receipt.identity === await readinessIdentity(spec)
      if (!valid) {
        const readiness = await this.checkReadiness(spec)
        this.readinessReceipts.delete(key)
        if (!readiness.ready) throw new RuntimeEnvironmentError(readiness.code ?? 'tool_preflight_failed', readiness.diagnostic ?? 'dsh tools are unavailable')
      }
    }
    if (this.closing || generation !== this.generation) throw new Error('executor is closing')
    await this.host.start()
    if (this.closing || generation !== this.generation) throw new Error('executor is closing')
    const run = new AcpRun(spec, {
      host: this.host,
      eofGraceMs: this.options.disposeEofGraceMs,
      graceMs: this.options.disposeGraceMs,
      startupTimeoutMs: this.options.startupTimeoutMs,
      promptTimeoutMs: this.options.promptTimeoutMs,
      closeTimeoutMs: this.options.closeTimeoutMs,
      disposeTimeoutMs: this.options.disposeTimeoutMs,
      requestControlChannel: this.options.requestControlChannel,
      onClosed: (runId) => {
        this.live.delete(runId)
      },
    })
    this.live.set(run.runId, run)
    try {
      await run.activate()
      return run
    } catch (error) {
      this.live.delete(run.runId)
      throw error
    }
  }

  checkReadiness(spec: Pick<RunSpec, 'cwd' | 'dshHome'>): Promise<RuntimeReadiness> {
    if (this.closing) return Promise.resolve({ ready: false, code: 'executor_closing', diagnostic: 'executor is closing' })
    const generation = this.generation
    const key = this.readinessKey(spec)
    this.readinessReceipts.delete(key)
    const check = (async () => {
      const result = await checkToolReadiness(spec, Math.min(this.options.startupTimeoutMs!, 30_000))
      if (result.ready && !this.closing && generation === this.generation) {
        const identity = await readinessIdentity(spec)
        if (this.closing || generation !== this.generation) return result
        // Bounded ephemeral receipts, never a cross-workspace/model availability cache.
        for (const [oldKey, value] of this.readinessReceipts) if (Date.now() - value.at >= 30_000) this.readinessReceipts.delete(oldKey)
        if (this.readinessReceipts.size >= 128) this.readinessReceipts.delete(this.readinessReceipts.keys().next().value!)
        this.readinessReceipts.set(key, { identity, at: Date.now() })
      }
      return result
    })().catch((error: unknown) => {
      if (error instanceof RangeExitUnconfirmedError) {
        this.readinessRangeUnconfirmed = true
        this.closing = true
        this.generation++
        this.readinessReceipts.clear()
      }
      throw error
    })
    this.readinessChecks.add(check)
    void check.finally(() => this.readinessChecks.delete(check)).catch(() => {})
    return check
  }

  private readinessKey(spec: Pick<RunSpec, 'cwd' | 'dshHome'>): string {
    return JSON.stringify([spec.cwd, spec.dshHome])
  }

  async closeAll(): Promise<void> {
    this.closeAllPromise ??= this.closeAllOnce().finally(() => {
      this.closeAllPromise = undefined
    })
    return this.closeAllPromise
  }

  private async closeAllOnce(): Promise<void> {
    this.closing = true
    this.generation++
    this.readinessReceipts.clear()
    const runs = [...this.live.values()]
    this.live.clear()
    const results = await Promise.allSettled(runs.map((run) => run.close()))
    const checks = await Promise.allSettled([...this.readinessChecks])
    results.push(await withDeadline('subprocess host disposal', this.options.disposeTimeoutMs!, () => this.host.dispose())
      .then(() => ({ status: 'fulfilled', value: undefined } as const), (reason: unknown) => ({ status: 'rejected', reason } as const)))
    // A host whose disposal timed out must not accept new children while it still owns a range.
    this.closing = this.readinessRangeUnconfirmed || results.at(-1)?.status === 'rejected'
    const failures = [...results, ...checks].filter((result) => result.status === 'rejected')
    if (failures.length === 0 && this.readinessRangeUnconfirmed) {
      throw new RangeExitUnconfirmedError('A prior dsh preflight still has unconfirmed managed range exit')
    }
    if (failures.length === 1 && failures[0]?.status === 'rejected') throw failures[0].reason
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((result) => result.status === 'rejected' ? result.reason : undefined),
        'closeAll failed for one or more runs',
      )
    }
  }

  private bindExit(): void {
    if (this.exitBound) return
    this.exitBound = true
    const shutdown = (): void => {
      void this.closeAll()
    }
    process.prependListener('SIGINT', shutdown)
    process.prependListener('SIGTERM', shutdown)
  }
}

export function createDshAcpExecutor(options: ExecutorOptions = {}): DshAcpExecutor {
  return new DshAcpRuntime(options)
}
