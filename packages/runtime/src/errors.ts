import { redactText } from './redaction.ts'

/** The process owner could not prove that an ACP worker range has exited. */
export class RangeExitUnconfirmedError extends Error {
  readonly code = 'range_exit_unconfirmed'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RangeExitUnconfirmedError'
  }
}

export class RuntimeEnvironmentError extends Error {
  readonly code: string

  constructor(code: string, diagnostic: string) {
    super(redactText(diagnostic).slice(0, 2_000))
    this.name = 'RuntimeEnvironmentError'
    this.code = code
  }
}

/** Only deterministic tool infrastructure faults; ordinary command/provider failures are not included. */
export function classifyRuntimeEnvironmentError(error: unknown): RuntimeEnvironmentError | null {
  if (error instanceof RuntimeEnvironmentError) return error
  // Upstream's generic message suggests disabling confinement; never relay that
  // as this product's recovery instruction.
  const text = diagnosticText(error).replace(/\s*[—-]\s*otherwise switch the consumer to danger-full-access\.?/gi, '')
  if (/SetNamedSecurityInfoW|WRITE_OWNER/i.test(text)) {
    const detail = text.match(/SetNamedSecurityInfoW[^;\n]*/i)?.[0] ?? text
    return new RuntimeEnvironmentError('sandbox_write_grant_failed',
      `dsh cannot initialize workspace-write permissions under the current execution identity. ${detail}`)
  }
  if (/SANDBOX_UNAVAILABLE|windows-acl-run:|sandbox.*(?:initialization|setup).*failed/i.test(text)) {
    return new RuntimeEnvironmentError('sandbox_unavailable', `dsh tool confinement is unavailable. ${text}`)
  }
  if (/native Windows Job containment/i.test(text)) {
    return new RuntimeEnvironmentError('process_containment_unavailable', text)
  }
  return null
}

/** Bounded error/cause traversal; redact before returning diagnostics to the service. */
export function diagnosticText(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error) || seen.size >= 8) return ''
  seen.add(error)
  if (!(error instanceof Error)) return redactText(String(error)).slice(0, 2_000)
  const details = [error.message]
  if ('code' in error) details.push(String(error.code))
  if (error.cause) details.push(diagnosticText(error.cause, seen))
  if (error instanceof AggregateError) {
    for (const child of error.errors.slice(0, 4)) details.push(diagnosticText(child, seen))
  }
  return redactText(details.join('; ')).slice(0, 2_000)
}
