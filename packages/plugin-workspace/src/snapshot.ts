import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { hashFile, sha256Text } from './hash.ts'

/** A complete version of the managed file tree. Links are never copied as files. */
export async function snapshotTree(root: string): Promise<string> {
  const entries: string[] = []
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(dir, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) {
        throw new WorkspaceError('invalid_path', `Managed target contains a symbolic link: ${relative}`)
      }
      if (stat.isDirectory()) await visit(absolute, relative)
      else if (stat.isFile()) entries.push(`${relative}\0${(await hashFile(absolute)).sha256}`)
      else throw new WorkspaceError('invalid_path', `Unsupported managed target entry: ${relative}`)
    }
  }
  await visit(root, '')
  return sha256Text(entries.sort().join('\n'))
}
