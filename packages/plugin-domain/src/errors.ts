export class DomainError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}

export const ErrorCode = {
  notFound: 'not_found',
  invalidInput: 'invalid_input',
  versionConflict: 'version_conflict',
  idempotencyConflict: 'idempotency_conflict',
  circularDependency: 'circular_dependency',
  lateResult: 'late_result',
  forbidden: 'forbidden',
  conflict: 'conflict',
} as const
