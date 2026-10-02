import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside, toPosix } from './paths.ts'

export interface WalkedFile {
  posixPath: string
  absPath: string
}

/**
 * Walk a directory. Skips `.git`. Does not follow directory symlinks.
 * File symlinks are kept only when the real path stays inside root.
 */
export async function walkFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  await walk(root, '', out)
  return out
}

async function walk(root: string, rel: string, out: WalkedFile[]): Promise<void> {
  const dir = rel ? join(root, rel) : root
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.' || entry.name === '..') continue
    const posixPath = rel ? `${rel}/${entry.name}` : entry.name
    const absPath = join(dir, entry.name)
    let stat
    try {
      stat = await lstat(absPath)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      try {
        const real = await realpath(absPath)
        if (!isInside(root, real)) continue
        const realStat = await lstat(real)
        if (realStat.isFile()) out.push({ posixPath, absPath })
      } catch {
        continue
      }
      continue
    }
    if (stat.isDirectory()) {
      await walk(root, posixPath, out)
      continue
    }
    if (stat.isFile()) out.push({ posixPath, absPath })
  }
}
