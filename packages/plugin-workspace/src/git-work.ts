import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { walkPresent } from './baseline.ts'
import { isUnderExcludedDirectory } from './exclusions.ts'
import { WorkspaceError } from './errors.ts'
import { isSensitivePath, gitIgnoredPaths } from './filter.ts'
import { Git } from './git.ts'
import { looksBinary, sha256Bytes } from './hash.ts'
import {
  catBlob,
  gitBlobId,
  listTree,
  type GitTool,
  type TreeEntry,
} from './objects.ts'
import { safeJoin } from './paths.ts'
import type { ArtifactStore } from './store.ts'
import type { FileChange, FilteredPath } from './types.ts'

export async function materializeCommit(tool: GitTool, repo: string, commit: string, destRoot: string): Promise<TreeEntry[]> {
  const entries = await listTree(tool, repo, commit)
  await mkdir(destRoot, { recursive: true })
  for (const entry of entries) {
    if (entry.mode === '120000' || entry.mode === '160000') {
      throw new WorkspaceError('invalid_path', `Refusing to materialize unsupported git entry ${entry.path}`)
    }
    // Tracked secrets stay in the service history and are not checked out.
    // Untracked excluded directories are not in the commit, so they are not copied.
    if (isSensitivePath(entry.path)) continue
    const bytes = await catBlob(tool, repo, entry.sha)
    if (gitBlobId(bytes, entry.sha.length) !== entry.sha) {
      throw new WorkspaceError('store_corrupt', `Service git blob ${entry.sha} does not match ${entry.path}`)
    }
    const path = safeJoin(destRoot, entry.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const written = await readFile(path)
    if (!written.equals(bytes)) throw new WorkspaceError('storage_full', `Materialized ${entry.path} was not stored completely`)
  }
  return entries
}

export async function diffGitWork(
  store: ArtifactStore,
  tool: GitTool,
  gitBin: string,
  repo: string,
  originCommit: string,
  workRoot: string,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  const tree = await listTree(tool, repo, originCommit)
  const baselinePaths = new Set(tree.map((entry) => entry.path))
  const present = await walkPresent(workRoot, baselinePaths)
  const ignored = await frozenGitIgnored(store, tool, gitBin, repo, tree, [...present.files.keys()])
  const before = new Map(tree.map((entry) => [entry.path, entry]))
  const files: FileChange[] = []
  const filtered: FilteredPath[] = []
  for (const path of present.omitted) filtered.push({ path, reason: 'ignored' })
  const paths = [...new Set([...before.keys(), ...present.files.keys()])].sort()
  for (const path of paths) {
    const prior = before.get(path)
    const after = present.files.get(path)
    if (!prior && after && (ignored.has(path) || isUnderExcludedDirectory(path))) {
      filtered.push({ path, reason: 'ignored' })
      continue
    }
    if (isSensitivePath(path)) {
      // Leaving a tracked secret out of the private view is not a deletion.
      if (!after) continue
      if (!prior) {
        filtered.push({ path, reason: 'sensitive' })
        continue
      }
      if (gitBlobId(await readFile(after.absPath), prior.sha.length) !== prior.sha) {
        filtered.push({ path, reason: 'sensitive' })
      }
      continue
    }
    if (!prior && after) {
      files.push(await storePresent(store, path, 'added', after.absPath))
      continue
    }
    if (prior && !after) {
      files.push({ path, kind: 'deleted', size: null, sha256: null, binary: false })
      continue
    }
    if (prior && after) {
      const bytes = await readFile(after.absPath)
      if (gitBlobId(bytes, prior.sha.length) !== prior.sha) files.push(await storeBytes(store, path, 'modified', bytes))
    }
  }
  return { files, filtered }
}

async function frozenGitIgnored(
  store: ArtifactStore,
  tool: GitTool,
  gitBin: string,
  repo: string,
  tree: readonly TreeEntry[],
  paths: string[],
): Promise<Set<string>> {
  const ignoreFiles = tree.filter((entry) => entry.path === '.gitignore' || entry.path.endsWith('/.gitignore'))
  if (ignoreFiles.length === 0 || paths.length === 0) return new Set()
  const view = join(store.root, 'scratch', `git-ignore-${originKey(tree)}`)
  const { rm } = await import('node:fs/promises')
  await rm(view, { recursive: true, force: true })
  for (const file of ignoreFiles) {
    const bytes = await catBlob(tool, repo, file.sha)
    const dest = safeJoin(view, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, bytes)
  }
  const scratch = join(store.root, 'scratch', 'ignore.git')
  await mkdir(scratch, { recursive: true })
  const setup = new Git(gitBin, store.root)
  await setup.run(['init', '--bare', scratch], { allowFailure: true })
  const git = new Git(gitBin, view)
  return gitIgnoredPaths(git, paths, { GIT_DIR: scratch, GIT_WORK_TREE: view })
}

function originKey(tree: readonly TreeEntry[]): string {
  const ignore = tree.find((entry) => entry.path === '.gitignore')
  return (ignore?.sha ?? 'none').slice(0, 12)
}

async function storePresent(store: ArtifactStore, path: string, kind: 'added' | 'modified', absPath: string): Promise<FileChange> {
  return storeBytes(store, path, kind, await readFile(absPath))
}

async function storeBytes(store: ArtifactStore, path: string, kind: 'added' | 'modified', bytes: Uint8Array): Promise<FileChange> {
  const sha = await store.putBlob(bytes)
  if (sha256Bytes(bytes) !== sha) throw new WorkspaceError('store_corrupt', `Stored blob drifted for ${path}`)
  return { path, kind, size: bytes.length, sha256: sha, binary: looksBinary(bytes) }
}
