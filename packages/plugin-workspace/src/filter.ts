import { Git } from './git.ts'

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.npmrc.user',
  'credentials.json',
  'secrets.json',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

/**
 * Paths that must never enter a delivery. Independent of gitignore so a
 * tracked `.env` edit is still dropped.
 */
export function isSensitivePath(posixPath: string): boolean {
  const lowered = posixPath.replace(/\\/g, '/')
  const parts = lowered.split('/')
  const base = parts[parts.length - 1] ?? ''
  if (parts.includes('.git') || parts.includes('.dsh') || parts.includes('.ssh')) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (SENSITIVE_BASENAMES.has(base)) return true
  if (/\.(pem|key|p12|pfx|kdbx|ks|jks)$/i.test(base)) return true
  return false
}

export async function gitIgnoredPaths(
  git: Git,
  posixPaths: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (posixPaths.length === 0) return ignored
  const input = Buffer.from(`${posixPaths.join('\0')}\0`, 'utf8')
  const extra = extraEnv?.GIT_DIR ? (['--no-index'] as const) : []
  const lines = await git.nulLines(['check-ignore', '-z', ...extra, '--stdin'], input, extraEnv)
  for (const line of lines) {
    if (line.length > 0) ignored.add(line.replace(/\\/g, '/'))
  }
  return ignored
}
