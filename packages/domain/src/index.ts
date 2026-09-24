export { DomainError, ErrorCode, isDomainError } from './errors.ts'
export { DomainService, hasDependencyCycle } from './service.ts'
export type {
  Actor,
  ActorKind,
  ApplicationDetail,
  ApplicationOutcome,
  BindRunInput,
  Claim,
  ClaimOptions,
  DeliveryInput,
  EvaluateInput,
  IdempotencyRef,
  IssueComment,
  IssueDetail,
  ListEventsFilter,
  ListIssuesFilter,
  OpenDomainOptions,
  PendingQuestion,
  PendingQuestionItem,
  ProfileHistoryEntry,
  RecoveredRun,
  RunDetail,
  RunFacts,
  StoredMessage,
} from './types.ts'

import { DomainService } from './service.ts'
import type { OpenDomainOptions } from './types.ts'

export function openDomain(databasePath: string | OpenDomainOptions): DomainService {
  return DomainService.open(typeof databasePath === 'string' ? { databasePath } : databasePath)
}
