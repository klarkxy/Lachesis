import { randomUUID } from 'node:crypto'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  ACP_MODEL_CONFIG_ID,
  ACP_REASONING_CONFIG_ID,
  acpModelOptionValue,
  type DeliveryStatus,
  type PermissionAnswer,
  type PermissionOption,
  type ProcessFacts,
  type PromptReceipt,
  type RouteSelection,
  type RunEvent,
  type RunHandle,
  type RunOutcome,
  type RunSpec,
  type RunState,
} from './types.ts'
import { EventHub } from './events.ts'
import { classifyRuntimeEnvironmentError, RangeExitUnconfirmedError } from './errors.ts'
import { redactText } from './redaction.ts'
import { assertAbsoluteDirectory, assertIsolatedDshHome } from './paths.ts'
import { connectAcpClient, methods, PROTOCOL_VERSION, type AcpAgent } from './acp.ts'
import { disposeAcpChild } from './subprocess.ts'
import type { SubprocessHost } from './subprocess.ts'
import { defaultAcpCommand, resolveArgv } from './command.ts'
import { withDeadline } from './deadline.ts'

const DEFAULT_EOF_GRACE_MS = 6_000
const DEFAULT_GRACE_MS = 3_000

export interface RunInternalOptions {
  host: SubprocessHost
  eofGraceMs?: number
  graceMs?: number
  startupTimeoutMs?: number
  promptTimeoutMs?: number
  closeTimeoutMs?: number
  disposeTimeoutMs?: number
  requestControlChannel?: boolean
  onClosed: (runId: string) => void
}

interface PendingPermission {
  requestId: string
  resolve: (response: RequestPermissionResponse) => void
}

export class AcpRun implements RunHandle {
  readonly runId = randomUUID()
  readonly events: AsyncIterable<RunEvent>
  readonly done: Promise<RunOutcome>

  private readonly hub = new EventHub<RunEvent>()
  private readonly spec: RunSpec
  private readonly options: RunInternalOptions
  private currentState: RunState = 'starting'
  private currentDelivery: DeliveryStatus = 'none'
  private currentRoute: RouteSelection | undefined
  private currentSessionId: string | undefined
  private facts: ProcessFacts | undefined
  private child: SubprocessHandle | undefined
  private agent: AcpAgent | undefined
  private connectionClose: (() => void) | undefined
  private permissionWaiters = new Map<string, PendingPermission>()
  private promptChain = Promise.resolve()
  private closed = false
  private readonly lifetime = new AbortController()
  private teardownPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private lastStop: StopReason | undefined
  private settleDone!: (outcome: RunOutcome) => void
  private processOutcome: SubprocessOutcome | undefined
  private rangeExited = false
  private failure: string | undefined
  private stderrOffset = 0

  constructor(spec: RunSpec, options: RunInternalOptions) {
    this.spec = spec
    this.options = options
    this.events = this.hub.iterate()
    this.done = new Promise((resolve) => {
      this.settleDone = resolve
    })
  }

  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  get state(): RunState {
    return this.currentState
  }

  get deliveryStatus(): DeliveryStatus {
    return this.currentDelivery
  }

  get route(): RouteSelection | undefined {
    return this.currentRoute
  }

  get processFacts(): ProcessFacts | undefined {
    return this.facts
  }

  async activate(): Promise<void> {
    try {
      await this.activateOnce()
    } catch (error: unknown) {
      this.failure = errorMessage(error)
      this.setState('failed')
      try {
        await this.teardown()
      } catch (disposalError) {
        throw new RangeExitUnconfirmedError('ACP startup failed and worker range exit is unconfirmed', {
          cause: new AggregateError([error, disposalError], 'ACP startup and teardown failed'),
        })
      }
      throw classifyRuntimeEnvironmentError(error) ?? (error instanceof Error ? error : new Error(this.failure))
    }
  }

  private async activateOnce(): Promise<void> {
    const cwd = assertAbsoluteDirectory('cwd', this.spec.cwd)
    const dshHome = assertIsolatedDshHome(this.spec.dshHome)
    const subprocess = this.options.host.subprocess
    const argv = await withDeadline('ACP executable resolution', this.options.startupTimeoutMs ?? 120_000,
      () => resolveArgv(subprocess, this.spec.command ?? defaultAcpCommand(), this.spec.env), this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    const graceMs = this.options.graceMs ?? DEFAULT_GRACE_MS
    const child = this.options.host.spawn({
      argv,
      cwd,
      graceMs,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 64 * 1024 },
        ...this.options.requestControlChannel === false ? {} : { control: 'pipe' as const },
      },
      env: {
        ...this.spec.env,
        DSH_HOME: dshHome,
      },
    })
    this.child = child
    this.facts = {
      controlChannelPresent: child.control !== undefined,
      stderrDisposition: 'collect',
      stdoutDisposition: 'pipe',
      stdinDisposition: 'pipe',
    }
    this.attachStderrPoll(child)
    void child.done.then(
      (outcome) => {
        this.processOutcome = outcome
      },
      (error: unknown) => {
        this.failure = errorMessage(error)
        this.setState('failed')
      },
    )

    const connection = connectAcpClient(child, {
      onUpdate: (notification) => {
        this.onSessionUpdate(notification)
      },
      onPermission: (request, requestId) => this.onPermission(request, requestId),
    })
    this.agent = connection.agent
    this.connectionClose = () => {
      connection.close()
    }

    const processRejected = child.done.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    )
    processRejected.catch(() => {})

    await Promise.race([
      withDeadline('ACP startup', this.options.startupTimeoutMs ?? 120_000,
        (signal) => this.handshake(cwd, signal), this.lifetime.signal),
      processRejected,
    ])
    this.lifetime.signal.throwIfAborted()
    this.setState('ready')
  }

  async send(text: string): Promise<PromptReceipt> {
    const run = this.promptChain.then(() => this.sendLocked(text))
    this.promptChain = run.then(() => undefined, () => undefined)
    return run
  }

  async answerPermission(requestId: string, answer: PermissionAnswer): Promise<void> {
    const waiter = this.permissionWaiters.get(requestId)
    if (waiter === undefined) {
      throw new Error(`unknown permission request: ${requestId}`)
    }
    this.permissionWaiters.delete(requestId)
    waiter.resolve(toPermissionResponse(answer))
    if (this.currentState === 'awaiting_permission') this.setState('prompting')
  }

  async cancel(): Promise<void> {
    const sessionId = this.currentSessionId
    const agent = this.agent
    if (sessionId === undefined || agent === undefined) return
    this.failPermissionWaiters()
    await withDeadline('ACP cancellation', this.options.closeTimeoutMs ?? 5_000,
      () => agent.notify(methods.agent.session.cancel, { sessionId }))
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce()
    return this.closePromise
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return await this.teardownPromise
    this.closed = true
    if (this.currentState !== 'failed') this.setState('closing')
    this.failPermissionWaiters()
    this.lifetime.abort(new Error('ACP run closed'))
    const sessionId = this.currentSessionId
    const agent = this.agent
    let closeError: unknown
    try {
      if (sessionId !== undefined && agent !== undefined) {
        await withDeadline('ACP session close', this.options.closeTimeoutMs ?? 5_000, async (signal) => {
          await agent.notify(methods.agent.session.cancel, { sessionId })
          signal.throwIfAborted()
          await agent.request(methods.agent.session.close, { sessionId }, { cancellationSignal: signal })
        })
      }
    } catch (error: unknown) {
      closeError = error
      this.failure ??= errorMessage(error)
      this.setState('failed')
    } finally {
      await this.teardown()
    }
    if (closeError) throw closeError
  }

  private async sendLocked(text: string): Promise<PromptReceipt> {
    if (this.closed || this.currentState === 'closed' || this.currentState === 'failed') {
      throw new Error(`cannot send on run in state ${this.currentState}`)
    }
    const sessionId = this.currentSessionId
    const agent = this.agent
    if (sessionId === undefined || agent === undefined) {
      throw new Error('ACP session is not ready')
    }
    if (this.currentState === 'prompting' || this.currentState === 'awaiting_permission') {
      throw new Error('one in-flight ACP prompt per session')
    }
    this.currentDelivery = 'none'
    this.setState('prompting')
    try {
      const result = await withDeadline('ACP prompt', this.options.promptTimeoutMs ?? 30 * 60_000,
        (signal) => agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text }],
        }, { cancellationSignal: signal }), this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      this.lastStop = result.stopReason
      this.hub.emit({ type: 'prompt_ended', stopReason: result.stopReason })
      if (result.stopReason === 'end_turn') {
        this.currentDelivery = 'pending_acceptance'
        this.setState('prompt_ended')
      } else {
        this.setState('ready')
      }
      return { stopReason: result.stopReason, promptEnded: true }
    } catch (error: unknown) {
      if (this.closed) throw error
      this.failure = errorMessage(error)
      this.setState('failed')
      await this.teardown()
      throw classifyRuntimeEnvironmentError(error) ?? (error instanceof Error ? error : new Error(this.failure))
    }
  }

  private async handshake(cwd: string, signal: AbortSignal): Promise<void> {
    const agent = this.agent
    if (agent === undefined) throw new Error('ACP client is not connected')
    await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }, { cancellationSignal: signal })
    signal.throwIfAborted()
    const created = await agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    }, { cancellationSignal: signal })
    signal.throwIfAborted()
    this.currentSessionId = created.sessionId
    this.hub.emit({ type: 'session', sessionId: created.sessionId })
    const selected = acpModelOptionValue(this.spec.provider, this.spec.model)
    let options = created.configOptions ?? []
    const modelResult = await agent.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: ACP_MODEL_CONFIG_ID,
      value: selected,
    }, { cancellationSignal: signal })
    signal.throwIfAborted()
    options = modelResult.configOptions
    assertCurrentValue(options, ACP_MODEL_CONFIG_ID, selected, 'provider/model')
    if (this.spec.reasoningEffort !== undefined) {
      const effortResult = await agent.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: ACP_REASONING_CONFIG_ID,
        value: this.spec.reasoningEffort,
      }, { cancellationSignal: signal })
      signal.throwIfAborted()
      options = effortResult.configOptions
      assertCurrentValue(options, ACP_REASONING_CONFIG_ID, this.spec.reasoningEffort, 'reasoningEffort')
    }
    this.currentRoute = {
      provider: this.spec.provider,
      model: this.spec.model,
      reasoningEffort: this.spec.reasoningEffort,
      modelOptionValue: selected,
      configOptions: options,
    }
    this.hub.emit({ type: 'route', route: this.currentRoute })
  }

  private onSessionUpdate(notification: SessionNotification): void {
    if (this.closed) return
    this.hub.emit({
      type: 'acp_update',
      sessionId: notification.sessionId,
      update: notification.update,
    })
  }

  private async onPermission(
    request: RequestPermissionRequest,
    requestId: string,
  ): Promise<RequestPermissionResponse> {
    if (this.closed) return { outcome: { outcome: 'cancelled' } }
    const options: PermissionOption[] = request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }))
    const mode = this.spec.permissionMode ?? 'defer'
    if (mode === 'allow-once') {
      const allow = options.find((option) => option.kind === 'allow_once' || option.optionId === 'allow-once')
      if (allow !== undefined) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    }
    if (mode === 'reject-once') {
      const reject = options.find((option) => option.kind === 'reject_once' || option.optionId === 'reject-once')
      if (reject !== undefined) {
        return { outcome: { outcome: 'selected', optionId: reject.optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    }
    this.setState('awaiting_permission')
    this.hub.emit({
      type: 'permission',
      requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCall.toolCallId,
      options,
    })
    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.permissionWaiters.set(requestId, { requestId, resolve })
    })
  }

  private attachStderrPoll(child: SubprocessHandle): void {
    const reader = child.collected.stderr
    if (reader === undefined) return
    const tick = (): void => {
      try {
        const chunk = reader.readFrom(this.stderrOffset)
        this.stderrOffset = chunk.nextOffset
        if (chunk.text.length > 0) {
          const text = redactText(chunk.text)
          this.hub.emit({ type: 'log', stream: 'stderr', text })
        }
      } catch {
        return
      }
      if (this.closed || this.currentState === 'closed' || this.currentState === 'failed') return
      setTimeout(tick, 40)
    }
    tick()
  }

  private failPermissionWaiters(): void {
    for (const waiter of this.permissionWaiters.values()) {
      waiter.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.permissionWaiters.clear()
  }

  private async teardown(): Promise<void> {
    this.teardownPromise ??= this.teardownOnce()
    return this.teardownPromise
  }

  private async teardownOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('ACP run ended'))
    this.failPermissionWaiters()
    this.connectionClose?.()
    this.connectionClose = undefined
    this.agent = undefined
    const child = this.child
    this.child = undefined
    let rangeExited = false
    let disposalError: unknown
    if (child !== undefined) {
      try {
        await disposeAcpChild(child, this.options.eofGraceMs ?? DEFAULT_EOF_GRACE_MS,
          this.options.disposeTimeoutMs ?? 13_000)
        rangeExited = true
      } catch (error: unknown) {
        disposalError = error
        this.failure ??= errorMessage(error)
        this.setState('failed')
      }
    }
    this.rangeExited = rangeExited
    const outcome = this.processOutcome
    this.hub.emit({
      type: 'process_exit',
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      rangeExited,
    })
    if (this.currentState !== 'failed') this.setState('closed')
    this.hub.end()
    this.options.onClosed(this.runId)
    this.settleDone({
      state: this.currentState,
      deliveryStatus: this.currentDelivery,
      stopReason: this.lastStop,
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      rangeExited,
      error: this.failure,
    })
    if (disposalError) throw disposalError
  }

  private setState(state: RunState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.hub.emit({ type: 'state', state })
  }
}

function toPermissionResponse(answer: PermissionAnswer): RequestPermissionResponse {
  if ('optionId' in answer) {
    return { outcome: { outcome: 'selected', optionId: answer.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

function selectCurrentValue(options: SessionConfigOption[], id: string): string | undefined {
  const option = options.find((item) => item.id === id)
  if (option === undefined || option.type !== 'select') return undefined
  return option.currentValue
}

function assertCurrentValue(
  options: SessionConfigOption[],
  id: string,
  expected: string,
  label: string,
): void {
  const current = selectCurrentValue(options, id)
  if (current !== expected) {
    throw new Error(
      `${label} was not applied: wanted ${JSON.stringify(expected)}, advertised ${JSON.stringify(current)}`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
