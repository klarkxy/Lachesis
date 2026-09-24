import type { SessionConfigOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'

/** Locked dsh npm train this adapter was implemented against. */
export const DSH_VERSION = '0.1.7-alpha.2'

/** ACP TypeScript SDK version required by dsh 0.1.7-alpha.2. */
export const ACP_SDK_VERSION = '1.4.0'

/** Shipped dsh automation profile. stdout is ACP JSON-RPC only. */
export const DSH_ACP_PROFILE = 'acp'

/** ACP session config ids used by `@deepseek-ai/dsh-acp` 0.1.7-alpha.2. */
export const ACP_MODEL_CONFIG_ID = 'model'
export const ACP_REASONING_CONFIG_ID = 'reasoning_effort'

/**
 * Opaque ACP select value for a provider/model route.
 * Matches dsh-acp `JSON.stringify([provider, model])`.
 */
export function acpModelOptionValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/** Empty ACP reasoning value means the provider default in dsh-acp. */
export const ACP_PROVIDER_DEFAULT_REASONING = ''

export type RunState =
  | 'starting'
  | 'ready'
  | 'prompting'
  | 'awaiting_permission'
  | 'prompt_ended'
  | 'closing'
  | 'closed'
  | 'failed'

/**
 * Delivery is owned by the Lachesis service, not the worker.
 * A finished prompt never auto-accepts.
 */
export type DeliveryStatus = 'none' | 'pending_acceptance'

export type PermissionMode = 'defer' | 'allow-once' | 'reject-once'

export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface RouteSelection {
  provider: string
  model: string
  reasoningEffort?: string
  modelOptionValue: string
  configOptions: SessionConfigOption[]
}

export interface ProcessFacts {
  /** True when subprocess-local published the extra duplex at fd 7. */
  controlChannelPresent: boolean
  /** Child stderr is collected and redacted; never inherited onto ACP stdout. */
  stderrDisposition: 'collect'
  stdoutDisposition: 'pipe'
  stdinDisposition: 'pipe'
}

export interface RunSpec {
  /** Absolute workspace. Becomes both spawn cwd and ACP `session/new` cwd. */
  cwd: string
  /**
   * Absolute isolated harness home for this Run.
   * Must not be the user `~/.dsh`. Ambient `DSH_*` names are scrubbed;
   * this value is forwarded explicitly as `DSH_HOME`.
   */
  dshHome: string
  provider: string
  model: string
  /** Omitted means leave the advertised provider default. */
  reasoningEffort?: string
  /**
   * Explicit child env merged after the subprocess scrub.
   * Pass only explicitly scoped credentials required by this Run, never broad
   * ambient credentials. Tombstones (`undefined`) remove ambient names.
   */
  env?: NodeJS.ProcessEnv
  /**
   * ACP child argv. Default is local `@deepseek-ai/dsh` `--profile acp` when installed
   * under this package, otherwise a PATH `dsh`.
   */
  command?: readonly string[]
  permissionMode?: PermissionMode
}

export interface ExecutorOptions {
  /** Close every live Run on SIGINT/SIGTERM. Tests should set false. Default true. */
  bindProcessExit?: boolean
  /** Total ACP initialization, session creation and route-selection deadline. Default 120 seconds. */
  startupTimeoutMs?: number
  /** Per-prompt deadline, including deferred permissions. Default 30 minutes. */
  promptTimeoutMs?: number
  /** Cooperative session close/cancel deadline. Default 5 seconds. */
  closeTimeoutMs?: number
  /** Managed-range exit deadline after terminate(), default disposeGraceMs + 10 seconds. */
  disposeTimeoutMs?: number
  /** stdin-EOF cooperative window before `terminate()`, matching dsh-subagent-acp. */
  disposeEofGraceMs?: number
  /** Subprocess `graceMs` (Windows Job terminate is immediate; POSIX uses TERM then KILL). */
  disposeGraceMs?: number
  /**
   * Request subprocess-local `stdio.control: 'pipe'` (fd 7).
   * ACP JSON-RPC still uses stdin/stdout. Default true.
   */
  requestControlChannel?: boolean
}

export interface PromptReceipt {
  stopReason: StopReason
  /** Prompt RPC settled. Not delivery acceptance. */
  promptEnded: true
}

export interface RunOutcome {
  state: RunState
  deliveryStatus: DeliveryStatus
  stopReason?: StopReason
  exitCode: number | null
  signal: NodeJS.Signals | null
  rangeExited: boolean
  error?: string
}

export type RunEvent =
  | { type: 'state'; state: RunState }
  | { type: 'route'; route: RouteSelection }
  | { type: 'session'; sessionId: string }
  | { type: 'acp_update'; sessionId: string; update: SessionUpdate }
  | {
      type: 'permission'
      requestId: string
      sessionId: string
      toolCallId: string
      options: PermissionOption[]
    }
  | { type: 'prompt_ended'; stopReason: StopReason }
  | { type: 'log'; stream: 'stderr'; text: string }
  | { type: 'process_exit'; exitCode: number | null; signal: NodeJS.Signals | null; rangeExited: boolean }

export type PermissionAnswer =
  | { optionId: string }
  | { cancelled: true }

export interface RunHandle {
  readonly runId: string
  readonly sessionId: string | undefined
  readonly state: RunState
  readonly deliveryStatus: DeliveryStatus
  readonly route: RouteSelection | undefined
  readonly processFacts: ProcessFacts | undefined
  readonly events: AsyncIterable<RunEvent>
  send(text: string): Promise<PromptReceipt>
  answerPermission(requestId: string, answer: PermissionAnswer): Promise<void>
  /** ACP `session/cancel` for the in-flight prompt. Does not close the session. */
  cancel(): Promise<void>
  /** ACP `session/close` then stdin-EOF / terminate / waitForExit. */
  close(): Promise<void>
  readonly done: Promise<RunOutcome>
}

export interface DshAcpExecutor {
  /** Only pass a fresh service-owned Run workspace, never the user's project target. */
  checkReadiness?(spec: Pick<RunSpec, 'cwd' | 'dshHome'>): Promise<RuntimeReadiness>
  start(spec: RunSpec): Promise<RunHandle>
  closeAll(): Promise<void>
}

export interface RuntimeReadiness {
  ready: boolean
  code: string | null
  diagnostic: string | null
}
