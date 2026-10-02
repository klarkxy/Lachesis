export type WorkspaceErrorCode =
  | 'invalid_path'
  | 'invalid_id'
  | 'invalid_command'
  | 'worker_running'
  | 'worker_unproven'
  | 'not_found'
  | 'dirty_worktree'
  | 'target_mismatch'
  | 'external_change'
  | 'unsupported_kind'
  | 'git_failed'
  | 'apply_failed'
  | 'recovery_required'
  | 'verification_failed'
  | 'store_corrupt'

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode
  readonly details: unknown

  constructor(code: WorkspaceErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.details = details
  }
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError
}
