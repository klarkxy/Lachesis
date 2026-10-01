import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function requireNativeWindowsJob(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await access(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')))
    const { loadWin32ProcessBindings, probeCurrentTokenJobSupport } = await import('@deepseek-ai/dsh-win32-process')
    probeCurrentTokenJobSupport(loadWin32ProcessBindings())
  } catch (error) {
    throw new Error('Lachesis requires native Windows Job containment for safe Run recovery', { cause: error })
  }
}

/**
 * Tiny Cordis host that owns `LocalSubprocessRuntime` and the confinement
 * decision made for every spawn (`LocalSandboxProvider`).
 * Service disposal terminates every still-owned managed range (Windows Job / POSIX
 * group), and on the windows-acl rung also revokes the private temp grants it made.
 */
export class SubprocessHost {
  private context: Context | undefined
  private subprocessService: SubprocessRuntime | undefined
  private starting: Promise<SubprocessRuntime> | undefined

  get subprocess(): SubprocessRuntime {
    if (this.subprocessService === undefined) {
      throw new Error('subprocess host is not started')
    }
    return this.subprocessService
  }

  async start(): Promise<SubprocessRuntime> {
    if (this.subprocessService !== undefined) return this.subprocessService
    this.starting ??= this.startOnce()
    return this.starting
  }

  private async startOnce(): Promise<SubprocessRuntime> {
    await requireNativeWindowsJob()
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    // One provider for the host's lifetime: the windows-acl rung caches its
    // standing workspace grant, so repeated wraps of the same workspace stay O(1).
    await context.plugin(LocalSandboxProvider)
    this.context = context
    this.subprocessService = context.subprocess
    return this.subprocessService
  }

  /**
   * Wrap `argv` so the spawned range is confined under `policy`. The provider
   * fails closed: a host with no usable runner throws the fail-closed
   * `SANDBOX_UNAVAILABLE` error rather than returning the caller's argv, so an
   * unconfined spawn is not reachable from here.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    const context = this.context
    if (context === undefined) throw new Error('subprocess host is not started')
    return await context.sandbox.confine(argv, policy, signal)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.subprocess.spawn(spec)
  }

  async dispose(): Promise<void> {
    await this.starting
    const context = this.context
    if (context === undefined) return
    await context.fiber.dispose()
    this.context = undefined
    this.subprocessService = undefined
    this.starting = undefined
  }
}

/** dsh-subagent-acp teardown ladder over the public subprocess verbs. */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number, exitTimeoutMs = 13_000): Promise<void> {
  const failures: unknown[] = []
  try {
    child.stdin?.end()
  } catch (error: unknown) {
    failures.push(error)
  }
  let exited = false
  try {
    exited = await waitForRange(child, eofGraceMs)
  } catch (error: unknown) {
    failures.push(error)
  }
  if (exited) return
  child.terminate()
  try {
    if (!await waitForRange(child, exitTimeoutMs)) {
      throw new Error(`ACP subprocess exit timed out after ${exitTimeoutMs} ms; managed range exit is unconfirmed`)
    }
  } catch (error: unknown) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'ACP subprocess teardown failed')
}

async function waitForRange(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
