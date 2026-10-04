/**
 * Directory names omitted from managed files captures.
 * A file whose own name is `build.ts` or `dist` stays; only a parent directory matches.
 * Git-tracked paths already in a baseline stay managed even under these names.
 */
export const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.dsh',
  '.ssh',
  'node_modules',
  'bower_components',
  'build',
  'dist',
  'coverage',
  'target',
  'out',
  'vendor',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
])

export function isExcludedDirectoryName(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name)
}

/** True when a file path sits under an excluded directory. The leaf name is not a directory. */
export function isUnderExcludedDirectory(posixPath: string): boolean {
  const parts = posixPath.split('/')
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (EXCLUDED_DIRECTORY_NAMES.has(parts[i] ?? '')) return true
  }
  return false
}

export function baselineHasPrefix(paths: ReadonlySet<string>, dirPosix: string): boolean {
  const prefix = `${dirPosix}/`
  for (const path of paths) {
    if (path === dirPosix || path.startsWith(prefix)) return true
  }
  return false
}
