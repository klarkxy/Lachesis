import type {
  Application,
  Delivery,
  Evaluation,
  Evidence,
  FileChange,
  Id,
  ISODate,
  Issue,
  IssueEvent,
  Page,
  Run,
  RunCheckpoint,
} from '@lachesis/contracts'

export type ActorKind = 'operator' | 'worker'

export interface Actor {
  kind: ActorKind
  id: string
}

export interface IdempotencyRef {
  key: string
  body: unknown
}

export interface OpenDomainOptions {
  databasePath: string
  /** Recover in-flight runs on open. Default true. */
  recoverInterrupted?: boolean
  /** SQLite busy timeout in milliseconds. Default 5000. */
  busyTimeoutMs?: number
}

export interface ProfileHistoryEntry {
  revision: number
  averageScore: number | null
  evaluatedCount: number
  issueIds: Id[]
}

export interface IssueComment {
  id: Id
  issueId: Id
  text: string
  author: string
  createdAt: ISODate
  delivered: boolean
}

export interface PendingQuestionItem {
  id: string
  text: string
  kind?: string
  options?: string[]
  required?: boolean
}

export interface PendingQuestion {
  id: Id
  runId: Id
  issueId: Id
  createdAt: ISODate
  questions: PendingQuestionItem[]
  answeredAt: ISODate | null
  answers: Record<string, string> | null
}

export interface IssueDetail {
  issue: Issue
  runs: Run[]
  deliveries: Delivery[]
  evaluation: Evaluation | null
  applications: Application[]
  questions: PendingQuestion[]
  comments: IssueComment[]
  checkpoints: RunCheckpoint[]
}

export interface RunFacts {
  generation: number
  claimedBy: string | null
}

export interface RunDetail {
  run: Run
  facts: RunFacts
}

export interface ApplicationDetail {
  application: Application
  evidence: Evidence[]
}

export interface DeliveryInput {
  id?: Id
  summary: string
  finalResponse?: string | null
  files: FileChange[]
  evidence: Evidence[]
  manifestSha256: string
}

export interface Claim {
  issue: Issue
  run: Run
  generation: number
}

export interface ClaimOptions {
  profileId: Id
  workspacePath?: string
  baseRef?: string | null
}

export interface BindRunInput {
  sessionId?: string | null
  workspacePath?: string
  baseRef?: string | null
}

export interface EvaluateInput {
  runId: Id
  deliveryId?: Id | null
  score: number
  comment: string
  expectedIssueVersion: number
}

export interface ApplicationOutcome {
  status: Application['status']
  expectedTarget?: string | null
  resultTarget?: string | null
  diagnostic?: string | null
  evidence?: Evidence[]
}

export interface ListIssuesFilter {
  projectId?: Id
  status?: Issue['status']
  cursor?: string | null
  limit?: number
}

export interface ListEventsFilter {
  projectId?: Id
  runId?: Id
  after?: number | string | null
  limit?: number
}

export interface RecoveredRun {
  runId: Id
  issueId: Id
  previousStatus: Run['status']
}

export interface StoredMessage {
  id: Id
  runId: Id
  text: string
  stored: true
  delivered: boolean
  createdAt: ISODate
}

export type { Page }
