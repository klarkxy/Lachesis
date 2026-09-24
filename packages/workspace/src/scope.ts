import { assertRelativePosix } from './paths.ts'
import { WorkspaceError } from './errors.ts'

function scopePath(value: string): { path: string; subtree: boolean } {
  if (typeof value !== 'string' || /[*?\[\]{}]/.test(value)) {
    throw new WorkspaceError('invalid_path', 'Delivery scopes require exact relative paths or trailing-slash subtrees')
  }
  const subtree = value.endsWith('/')
  const raw = assertRelativePosix('scope', subtree ? value.slice(0, -1) : value)
  const path = process.platform === 'win32' ? raw.toLowerCase() : raw
  return { path, subtree }
}

/** Return changed files outside declared ownership, including every read-only path. */
export function checkDeliveryScope(
  files: readonly { path: string }[],
  ownedPaths: readonly string[],
  readOnlyPaths: readonly string[],
): string[] {
  const owned = ownedPaths.map(scopePath)
  const readOnly = readOnlyPaths.map(scopePath)
  const covers = (file: string, scope: { path: string; subtree: boolean }) =>
    scope.subtree ? file.startsWith(`${scope.path}/`) : file === scope.path
  const bad: string[] = []
  for (const file of files) {
    try {
      assertRelativePosix('delivery file', file.path)
      const compared = process.platform === 'win32' ? file.path.toLowerCase() : file.path
      if (readOnly.some((scope) => covers(compared, scope)) ||
        (owned.length > 0 && !owned.some((scope) => covers(compared, scope)))) bad.push(file.path)
    } catch {
      bad.push(file.path)
    }
  }
  return [...new Set(bad)].sort()
}
