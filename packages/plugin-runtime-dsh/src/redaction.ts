import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

const BEARER = /Bearer\s+\S+/gi
const KEYISH = /\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{8,}\b/g
const ASSIGNMENT = /\b([A-Za-z0-9_]*?(?:KEY|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi

/** Drop credential-shaped text from child stderr before it is logged or emitted. */
export function redactText(text: string): string {
  return text
    .replace(ASSIGNMENT, '$1=[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(KEYISH, '[redacted-key]')
}

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERN.test(name)
}

export { SENSITIVE_ENV_PATTERN }
