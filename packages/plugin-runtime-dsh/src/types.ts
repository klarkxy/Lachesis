import type { SessionConfigOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox'

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

/**
 * A confining mode a Run harness range may execute under. `danger-full-access`
 * is deliberately absent: a Run that cannot be confined must fail closed, never
 * widen itself out of the sandbox.
 */
export type RunSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/** Every whole-range harness uses this mode unless a caller asks for another. */
export const DEFAULT_RUN_SANDBOX_MODE: RunSandboxMode = 'workspace-write'

/**
 * `whole-range` applies the outer local sandbox to the harness.
 * `native-tools` keeps the native Job and the pinned DSH workspace-write tools,
 * and does not apply that outer confine. Omitted means whole-range.
 * A failed Run never switches this choice.
 */
export type RunBoundaryMode = 'whole-range' | 'native-tools'

/** Outer confinement remains the default. `native-tools` is explicit. */
export const DEFAULT_RUN_BOUNDARY_MODE: RunBoundaryMode = 'whole-range'

/** How the caller asks for this Run's harness range to be bounded. */
export interface RunSandboxSpec {
  /**
   * Explicit Run-owned writable root (`execution/<runId>/box`).
   * The pinned runtime requires it. Custom fixture commands may omit it.
   */
  workspaceRoot?: string
  /**
   * Private temp parent (`execution/<runId>/tmp`), the direct `tmp` sibling of
   * `workspaceRoot`. Omitted keeps the fixture temp beside the private home.
   */
  tempRoot?: string
  accessMode?: 'read-only' | 'workspace-write'
  requireFull?: boolean
  /**
   * File-effect mode. Default {@link DEFAULT_RUN_SANDBOX_MODE}.
   * Under `whole-range`, `read-only` denies writes outside the granted root.
   * Under `native-tools`, only `workspace-write` is accepted; read-only and
   * full are refused before readiness or spawn.
   */
  mode?: RunSandboxMode
  /** Default {@link DEFAULT_RUN_BOUNDARY_MODE}. Never inferred from a failure. */
  boundaryMode?: RunBoundaryMode
}

/**
 * Boundary evidence for one Run.
 * `whole-range` records the outer wrap. `native-tools` records a trusted-host
 * harness and a separate tool enforcement; it does not describe the harness
 * itself as a partial sandbox.
 */
export type RunSandboxFacts = WholeRangeSandboxFacts | NativeToolsSandboxFacts

/** Outer wrap facts. `boundaryMode` is omitted by older readers' fixtures. */
export interface WholeRangeSandboxFacts {
  boundaryMode?: 'whole-range'
  mode: RunSandboxMode
  /** The single writable root the outer wrap granted the harness. */
  workspaceRoot: string
  enforcement: SandboxEnforcement
  /** The backend's own denial dialect; empty when the backend names none. */
  denialSignatures: readonly string[]
}

/** Trusted harness plus the pinned tool sandbox. No outer harness confinement. */
export interface NativeToolsSandboxFacts {
  boundaryMode: 'native-tools'
  mode: RunSandboxMode
  /** Validated run box. Not an outer writable grant on the harness. */
  workspaceRoot: string
  /** Actual native session tool boundary, distinct from the private box. */
  toolWorkspaceRoot?: string
  /** Private SDK temporary parent; children receive separate capabilities. */
  tempRoot?: string
  harnessEnforcement: 'trusted-host'
  /** Pinned tool backend. `partial` on win32. This is not harness confinement. */
  toolEnforcement: 'full' | 'partial' | 'probed'
  denialSignatures: readonly string[]
}

/** A settled harness range that confinement stopped, or could not confine. */
export interface RunSandboxVerdict {
  mode: RunSandboxMode
  enforcement: SandboxEnforcement
  /** Confinement worked and denied a file effect. */
  denied: boolean
  /** The runner failed before the harness could execute at all. */
  runnerFailed: boolean
  /** The matching stderr line, when one identified the cause. */
  detail: string | null
}

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
  /**
   * Boundary evidence. whole-range carries the outer wrap. native-tools
   * carries trusted-host Job ownership and separate tool enforcement.
   */
  sandbox: RunSandboxFacts
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
   * ACP child argv. Default is the package-local pinned `@deepseek-ai/dsh`
   * `--profile acp`. A missing pin is an error; PATH `dsh` is not used.
   * An explicit command remains the custom-transport test seam.
   */
  command?: readonly string[]
  permissionMode?: PermissionMode
  /**
   * Spawn-time confinement for this Run's harness range. Omitting it confines
   * under {@link DEFAULT_RUN_SANDBOX_MODE} — confinement is the default, never
   * an opt-in.
   */
  sandbox?: RunSandboxSpec
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
  /**
   * Set when confinement denied the harness range, or the runner itself failed.
   * Present even for an otherwise clean exit, so a killed range is never
   * reported as ordinary completion.
   */
  sandboxViolation?: RunSandboxVerdict
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
  | { type: 'sandbox_violation'; verdict: RunSandboxVerdict }
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

export interface ExecutionPolicyRequest {
  accessMode: 'read-only' | 'workspace-write'
  requireFull: boolean
}

export interface ExecutionPolicySupport {
  supported: boolean
  diagnostic: string | null
}

export interface DshAcpExecutor {
  /**
   * Queue-time gate. An unsupported issue stays unclaimed so one read-only or
   * full request cannot block the rest of the project. Omitted means the
   * caller has not asked this executor to refuse a policy up front.
   */
  executionPolicySupport?(policy: ExecutionPolicyRequest): ExecutionPolicySupport
  /** Only pass a fresh service-owned Run workspace, never the user's project target. */
  checkReadiness?(spec: Pick<RunSpec, 'cwd' | 'dshHome' | 'sandbox'>): Promise<RuntimeReadiness>
  start(spec: RunSpec): Promise<RunHandle>
  closeAll(): Promise<void>
}

export interface RuntimeReadiness {
  ready: boolean
  code: string | null
  diagnostic: string | null
}
