/** Public Lachesis API contract. IDs are opaque and server generated. */
export type Id = string
export type ISODate = string
export type WorkspaceKind = 'git' | 'files'
export type AccessMode = 'read-only' | 'workspace-write'
export type AttendanceMode = 'manual' | 'bounded-unattended'
export type ExecutionBoundaryMode = 'whole-range' | 'native-tools'

/** Claim-time intent. Historical runs without this field have unknown full configuration. */
export interface ExecutionSnapshot {
  schemaVersion: 1
  harnessId: string
  adapterVersion: string
  config: Record<string, unknown>
  accessMode: AccessMode
  attendance: AttendanceMode
  isolationRequirement: 'trusted-host' | 'full'
  /** Frozen boundary; absent on historical snapshots means unknown. */
  boundaryMode?: ExecutionBoundaryMode
  capacityKey: string
  sourceSelection: { kind: WorkspaceKind; baseRef: string | null }
}

/** Bound exactly once after preparation and before the first model request. */
export interface RunInputBinding {
  executionSnapshotDigest: string
  baseRef: string | null
  materializedDigest: string
  captureGuarantee: 'fixed-commit' | 'captured-bytes'
  /** Digest only; never embeds provider configuration or credentials. */
  harnessConfigDigest?: string | null
  boundAt: ISODate
}

export interface StoragePolicy {
  maxManagedBytes: number | null
  minFreeBytes: number
  defaultRunReserveBytes: number
  artifactPublishReserveBytes: number
  maxCacheBytes: number
  executionRetentionHours: number
  checkpointRetentionDays: number | null
}

export const DEFAULT_STORAGE_POLICY: Readonly<StoragePolicy> = Object.freeze({
  maxManagedBytes: null, minFreeBytes: 0, defaultRunReserveBytes: 0, artifactPublishReserveBytes: 0,
  maxCacheBytes: 0, executionRetentionHours: 0, checkpointRetentionDays: null,
})

export interface StorageStatus {
  policy: StoragePolicy
  managedBytes: number
  freeBytes: number
  reservedBytes: number
  activeReservations: number
  canDispatch: boolean
  diagnostic: string | null
}

/** Metadata-only observation; no worker or project contents are exposed. */
export interface StorageObservation {
  managedBytes: number
  freeBytes: number
  runBytes: Record<Id, number>
  observedAt: ISODate
}

export interface StorageAdmission {
  observation: StorageObservation
  requiredBytes: number
  sourceRef: string | null
  policyDigest: string
}

export interface StorageReservation {
  runId: Id
  generation: number
  bytes: number
  /** Remaining future allocation at the most recent preparation milestone. */
  remainingBytes: number
  executionBaseBytes: number
  createdAt: ISODate
  artifactReady: boolean
  published: boolean
}

/** Existing SQLite owns production reservations. Standalone workspace tests may use memory. */
export interface StorageReservationBackend {
  list(): StorageReservation[]
  acquire(runId: Id, bytes: number, observation: StorageObservation): StorageReservation
  materialized(runId: Id, remainingBytes: number, executionBaseBytes: number): void
  artifactReady(runId: Id): void
  assertCleanupAllowed(runId: Id): void
  release(runId: Id): void
}
export type IssueStatus =
  | 'queued' | 'blocked' | 'starting' | 'running' | 'needs_input'
  | 'awaiting_review' | 'accepted' | 'failed' | 'cancelled' | 'recovery_required'
export type RunStatus =
  | 'starting' | 'running' | 'needs_input' | 'cancelling'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovery_required'
export type ApplicationStatus =
  | 'queued' | 'integrating' | 'conflict' | 'ready'
  | 'applying' | 'applied' | 'failed' | 'recovery_required'

export interface Project {
  id: Id
  name: string
  kind: WorkspaceKind
  rootPath: string
  targetBranch: string | null
  verificationCommand: string | null
  createdAt: ISODate
}

export interface Profile {
  id: Id
  name: string
  avatarPresetId: string
  /** Harness that executes this Profile, e.g. "dsh-acp-0.1.7" or "aider-0.86". */
  harnessId: string
  /** JSON.stringify of the harness specific configuration. */
  configJson: string
  /** ACP mirror of configJson kept for dsh compatibility. */
  providerRef: string
  modelId: string
  reasoningEffort: string | null
  revision: number
  disabled: boolean
  createdAt: ISODate
}

export interface ProfileRevision {
  profileId: Id
  revision: number
  providerRef: string
  modelId: string
  reasoningEffort: string | null
  createdAt: ISODate
  harnessId?: string | null
  configJson?: string | null
}

export interface Dispatch {
  mode: 'require' | 'auto'
  profileId: Id | null
}

export interface Issue {
  id: Id
  projectId: Id
  title: string
  description: string
  acceptanceCriteria: string[]
  dispatch: Dispatch
  dependsOn: Id[]
  /** Omitted on legacy clients; an empty list means unrestricted scope. */
  ownedPaths?: string[]
  readOnlyPaths?: string[]
  accessMode?: AccessMode
  attendance?: AttendanceMode
  isolationRequirement?: 'trusted-host' | 'full'
  requesterRef: string
  clientRequestId: string | null
  status: IssueStatus
  version: number
  currentRunId: Id | null
  acceptedDeliveryId: Id | null
  createdAt: ISODate
  updatedAt: ISODate
}

export interface Run {
  id: Id
  issueId: Id
  attempt: number
  status: RunStatus
  profileId: Id
  profileRevision: number
  providerRef: string
  modelId: string
  reasoningEffort: string | null
  sessionId: string | null
  workspacePath: string
  baseRef: string | null
  startedAt: ISODate | null
  endedAt: ISODate | null
  executionSnapshot?: ExecutionSnapshot | null
  inputBinding?: RunInputBinding | null
}

export interface FileChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  size: number | null
  sha256: string | null
  binary: boolean
}

export interface Delivery {
  id: Id
  issueId: Id
  runId: Id
  profileId: Id
  profileRevision: number
  summary: string
  finalResponse: string | null
  files: FileChange[]
  evidence: Evidence[]
  manifestSha256: string
  createdAt: ISODate
}

export interface Evidence {
  kind: 'tool_result' | 'model_report' | 'verification' | 'lifecycle'
  label: string
  outcome: 'passed' | 'failed' | 'unknown'
  detail: string | null
}

export interface Evaluation {
  id: Id
  issueId: Id
  deliveryId: Id | null
  runId: Id
  profileId: Id
  profileRevision: number
  score: number
  comment: string
  revision: number
  active: boolean
  createdAt: ISODate
}

export interface Application {
  id: Id
  projectId: Id
  issueId: Id
  deliveryId: Id
  status: ApplicationStatus
  expectedTarget: string | null
  resultTarget: string | null
  diagnostic: string | null
  createdAt: ISODate
  updatedAt: ISODate
}

export interface IssueEvent {
  sequence: number
  projectId: Id
  issueId: Id | null
  runId: Id | null
  type: string
  data: unknown
  createdAt: ISODate
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface ApiSuccess<T> {
  data: T
}

export interface CreateIssueInput {
  projectId: Id
  title: string
  description: string
  acceptanceCriteria: string[]
  dispatch: Dispatch
  dependsOn?: Id[]
  ownedPaths?: string[]
  readOnlyPaths?: string[]
  accessMode?: AccessMode
  attendance?: AttendanceMode
  isolationRequirement?: 'trusted-host' | 'full'
  requesterRef: string
  clientRequestId?: string
}

export interface CreateProfileInput {
  name: string
  avatarPresetId: string
  providerRef: string
  modelId: string
  reasoningEffort: string | null
  /** Defaults to the dsh ACP harness when omitted. */
  harnessId?: string
  /** Defaults to a mirror of the ACP fields when omitted; must be a JSON object. */
  configJson?: string
}

export interface CreateProjectInput {
  name: string
  kind: WorkspaceKind
  rootPath: string
  targetBranch?: string
  verificationCommand?: string
}

export interface SchedulerSettings {
  version: number
  globalMaxActive: number
  profileLimits: Record<string, number>
  providerLimits: Record<string, number>
}

export interface EnvironmentBlock {
  code: string
  diagnostic: string
  createdAt: ISODate
}

export interface ProjectDispatchState {
  projectId: Id
  version: number
  paused: boolean
  environmentBlock: EnvironmentBlock | null
  activeRunCount: number
  drainComplete: boolean
}

export type DispatchReason = 'ready' | 'dependency' | 'paused' | 'environment' | 'global_capacity'
  | 'storage_capacity'
  | 'profile_capacity' | 'provider_capacity' | 'profile_unavailable' | 'scope_busy'
  | 'running' | 'needs_input' | 'review' | 'integration' | 'complete' | 'failed' | 'cancelled' | 'recovery'

export interface DispatchDecision {
  issueId: Id
  issueTitle?: string
  profileId: Id | null
  reason: DispatchReason
  detail: string
}

export interface SchedulerSnapshot {
  settings: SchedulerSettings
  activeRunCount: number
  profileActiveCounts: Record<string, number>
  providerActiveCounts: Record<string, number>
  projects: ProjectDispatchState[]
  decisions: DispatchDecision[]
}

export interface UpdateIssuePlanInput {
  expectedIssueVersion: number
  dependsOn?: Id[]
  ownedPaths?: string[]
  readOnlyPaths?: string[]
  accessMode?: AccessMode
  attendance?: AttendanceMode
  isolationRequirement?: 'trusted-host' | 'full'
}

/** An unfinished artifact. It cannot be accepted or applied as a Delivery. */
export interface RunCheckpoint {
  id: Id
  issueId: Id
  runId: Id
  baseRef: string | null
  manifestSha256: string
  files: FileChange[]
  reason: string
  createdAt: ISODate
}

export interface VerificationReport {
  command: string[]
  exitCode: number | null
  signal: string | null
  startedAt: ISODate
  finishedAt: ISODate
  truncated: boolean
  omittedBytes: number
  output: string
  summary: string
}
