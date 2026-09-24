import type {
  ApplicationStatus,
  Evidence,
  FileChange,
  WorkspaceKind,
} from '@lachesis/contracts'

export type { ApplicationStatus, Evidence, FileChange, WorkspaceKind }

export interface WorkspaceOptions {
  /** Absolute directory for worktrees, snapshots, immutable blobs, logs, and backups. */
  storeRoot: string
  /** Git executable. Default `git` (looked up on PATH; Windows also tries `.exe`). */
  gitBin?: string
}

export interface WorkerStopProof {
  /**
   * Execution range has exited (from the ACP runtime). When provided it must be true.
   * Freeze refuses a missing proof — a boolean flag with no pid/confirm is not enough
   * unless `rangeExited` is explicitly true or `pid`/`confirm` is supplied.
   */
  rangeExited?: boolean
  /** Worker pid. Freeze sends signal 0 and refuses if the process is still alive. */
  pid?: number
  /** Extra stop check (session closed, handle.done settled, …). Must return true. */
  confirm?: () => Promise<boolean>
}

export interface PrepareRunInput {
  runId: string
  kind: WorkspaceKind
  /** Absolute project root (git work tree or ordinary directory). */
  projectRoot: string
  /** Git projects: local branch to pin. Null uses the project's current HEAD. */
  targetBranch: string | null
  /** Rework starts from the immutable accepted delivery in a fresh Run. */
  seedDeliveryId?: string
}

export interface PreparedWorkspace {
  runId: string
  kind: WorkspaceKind
  workspacePath: string
  /** Git: pinned commit. Files: `files:<digest>` of the baseline tree. */
  baseRef: string | null
  targetBranch: string | null
  projectRoot: string
  baselinePath: string | null
}

export interface FreezeDeliveryInput {
  runId: string
  deliveryId: string
  worker: WorkerStopProof
}

export interface FilteredPath {
  path: string
  reason: 'ignored' | 'sensitive'
}

export interface FrozenManifest {
  deliveryId: string
  runId: string
  kind: WorkspaceKind
  baseRef: string | null
  /** Original project commit used to display cumulative Git rework changes. */
  originBaseRef?: string | null
  files: FileChange[]
  filtered: FilteredPath[]
  manifestSha256: string
  /** Git object created with commit-tree; files kind uses a sandbox commit. */
  gitCommit: string | null
  createdAt: string
}

export interface IntegrateInput {
  applicationId: string
  deliveryId: string
  projectRoot: string
  targetBranch: string | null
  verificationCommand: string | readonly string[] | null
  verificationTimeoutMs?: number
}

export interface IntegrationOutcome {
  applicationId: string
  deliveryId: string
  status: Extract<ApplicationStatus, 'conflict' | 'ready' | 'failed'>
  expectedTarget: string | null
  resultTarget: string | null
  diagnostic: string | null
  evidence: Evidence[]
  conflictPaths: string[]
  integrationPath: string
}

export interface ApplyInput {
  applicationId: string
  /**
   * Caller-supplied expected target (HTTP body). Must match the candidate's
   * recorded target; git also requires HEAD to still be that commit.
   */
  expectedTarget: string | null
  verificationCommand: string | readonly string[] | null
  verificationTimeoutMs?: number
}

export interface ApplyOutcome {
  applicationId: string
  status: Extract<ApplicationStatus, 'applied' | 'failed' | 'recovery_required'>
  resultTarget: string | null
  diagnostic: string | null
  evidence: Evidence[]
  rollbackRef: string | null
  logPath: string
}

export interface DeliveryFileBytes {
  file: FileChange
  bytes: Uint8Array
}

export interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated?: boolean
  omittedBytes?: number
  timedOut?: boolean
}
