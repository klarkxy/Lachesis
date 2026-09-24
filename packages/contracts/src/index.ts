/** Public Lachesis API contract. IDs are opaque and server generated. */
export type Id = string
export type ISODate = string
export type WorkspaceKind = 'git' | 'files'
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
  requesterRef: string
  clientRequestId?: string
}

export interface CreateProfileInput {
  name: string
  avatarPresetId: string
  providerRef: string
  modelId: string
  reasoningEffort: string | null
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
