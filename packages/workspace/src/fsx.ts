import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fromPosix } from './paths.ts'

export async function rmRetry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
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
