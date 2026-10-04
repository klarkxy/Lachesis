import { cp, lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fromPosix } from './paths.ts'

export type DurabilityLevel = 'file-sync' | 'directory-sync'

export async function rmRetry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
}

/**
 * True only when `path` is confirmed absent. A thrown or incomplete delete keeps the
 * caller from releasing a reservation over residue that is still on disk.
 */
export async function removeConfirmed(path: string): Promise<boolean> {
  try {
    await rmRetry(path)
  } catch {
    return false
  }
  try {
    await lstat(path)
    return false
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
  }
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, {
    recursive: true,
    force: true,
    dereference: false,
    errorOnExist: false,
    filter: (source) => {
      const base = source.replace(/\\/g, '/').split('/').pop() ?? ''
      return base !== '.git'
    },
  })
}

export async function emptyDirKeepGit(dir: string): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(dir)
  await Promise.all(
    names
      .filter((name) => name !== '.git')
      .map((name) => rmRetry(join(dir, name))),
  )
}

export function posixJoin(root: string, posixPath: string): string {
  return join(root, fromPosix(posixPath))
}

/** Write a file and flush it. Directory sync is attempted and reported, never invented. */
export async function writeDurable(path: string, data: Uint8Array | string): Promise<DurabilityLevel> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return syncDirectory(dirname(path))
}

export async function syncDirectory(dir: string): Promise<DurabilityLevel> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
      return 'directory-sync'
    } finally {
      await handle.close()
    }
  } catch {
    return 'file-sync'
  }
}
