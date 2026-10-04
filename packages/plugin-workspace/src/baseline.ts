import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { baselineHasPrefix, isExcludedDirectoryName, isUnderExcludedDirectory } from './exclusions.ts'
import { WorkspaceError } from './errors.ts'
import { writeDurable } from './fsx.ts'
import { gitIgnoredPaths, isSensitivePath } from './filter.ts'
import { Git } from './git.ts'
import { hashFile, looksBinary, sha256Bytes, sha256Text } from './hash.ts'
import { assertRelativePosix, safeJoin } from './paths.ts'
import type { ArtifactStore } from './store.ts'
import type { FileChange, FilteredPath } from './types.ts'

export interface BaselineFile {
  path: string
  sha256: string
  size: number
  mode: '100644' | '100755'
}

export interface BaselineManifest {
  schemaVersion: 1
  baselineId: string
  ruleVersion: 1
  capture: 'captured-bytes'
  files: BaselineFile[]
  digest: string
}

const RULE = 'managed-v1'

export function baselineDigest(files: readonly BaselineFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sha256}\0${file.mode}\0${file.size}`)
    .join('\n')
  return sha256Text(`${RULE}\n${canonical}`)
}

export function baselineDir(store: ArtifactStore, baselineId: string): string {
  if (!/^[a-f0-9]{64}$/.test(baselineId)) throw new WorkspaceError('store_corrupt', `Invalid baseline id ${baselineId}`)
  return join(store.root, 'baselines', baselineId)
}

export async function loadBaseline(store: ArtifactStore, baselineId: string): Promise<BaselineManifest> {
  const manifest = await store.readJson<BaselineManifest>(join(baselineDir(store, baselineId), 'manifest.json'))
  if (manifest.baselineId !== baselineId || manifest.ruleVersion !== 1 || manifest.capture !== 'captured-bytes') {
    throw new WorkspaceError('store_corrupt', `Baseline ${baselineId} is not a managed capture`)
  }
  if (baselineDigest(manifest.files) !== manifest.digest || manifest.baselineId !== manifest.digest) {
    throw new WorkspaceError('store_corrupt', `Baseline ${baselineId} manifest does not match its files`)
  }
  return manifest
}

export async function estimateManagedBytes(root: string): Promise<number> {
  const hashed = await hashManagedTree(root)
  return [...hashed.values()].reduce((sum, file) => sum + file.size, 0)
}

/**
 * Capture a files tree into shared blobs. Two identical trees share one manifest.
 * Excluded directories are not entries, so their absence is not a deletion later.
 */
export async function captureFilesBaseline(store: ArtifactStore, root: string): Promise<BaselineManifest> {
  let stable: Map<string, BaselineFile> | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await hashManagedTree(root)
    const after = await hashManagedTree(root)
    if (canonical(before) === canonical(after)) {
      stable = before
      break
    }
  }
  if (!stable) throw new WorkspaceError('target_mismatch', 'Target changed during baseline snapshot')
  for (const file of stable.values()) {
    const bytes = await readFile(safeJoin(root, file.path))
    const actual = sha256Bytes(bytes)
    if (actual !== file.sha256) throw new WorkspaceError('target_mismatch', 'Target changed during baseline snapshot')
    const stored = await store.putBlob(bytes)
    if (stored !== file.sha256) throw new WorkspaceError('store_corrupt', `Blob id drifted for ${file.path}`)
  }
  const files = [...stable.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  const digest = baselineDigest(files)
  const manifest: BaselineManifest = {
    schemaVersion: 1,
    baselineId: digest,
    ruleVersion: 1,
    capture: 'captured-bytes',
    files,
    digest,
  }
  const dest = join(baselineDir(store, digest), 'manifest.json')
  try {
    const existing = await loadBaseline(store, digest)
    if (existing.digest !== digest) throw new WorkspaceError('store_corrupt', 'Baseline id collision')
    return existing
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') {
      if (error instanceof WorkspaceError && error.code === 'store_corrupt') throw error
      if (!(error instanceof WorkspaceError)) throw error
    }
  }
  await writeDurable(dest, `${JSON.stringify(manifest, null, 2)}\n`)
  return loadBaseline(store, digest)
}

export async function materializeFilesBaseline(store: ArtifactStore, baselineId: string, destRoot: string): Promise<BaselineManifest> {
  const manifest = await loadBaseline(store, baselineId)
  await mkdir(destRoot, { recursive: true })
  for (const file of manifest.files) {
    if (isSensitivePath(file.path)) continue
    const bytes = Buffer.from(await store.getBlob(file.sha256))
    const path = safeJoin(destRoot, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const written = await readFile(path)
    if (sha256Bytes(written) !== file.sha256) {
      throw new WorkspaceError('storage_full', `Materialized ${file.path} did not match its blob`)
    }
  }
  return manifest
}

export async function readBaselineFile(store: ArtifactStore, baselineId: string, posixPath: string): Promise<Uint8Array> {
  const path = assertRelativePosix('path', posixPath)
  const manifest = await loadBaseline(store, baselineId)
  const file = manifest.files.find((entry) => entry.path === path)
  if (!file) throw new WorkspaceError('not_found', `Baseline has no file ${path}`)
  return store.getBlob(file.sha256)
}

async function hashManagedTree(root: string): Promise<Map<string, BaselineFile>> {
  const files = new Map<string, BaselineFile>()
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(dir, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new WorkspaceError('invalid_path', `Managed target contains a symbolic link: ${relative}`)
      if (stat.isDirectory()) {
        if (isExcludedDirectoryName(entry.name)) continue
        await visit(absolute, relative)
        continue
      }
      if (!stat.isFile()) throw new WorkspaceError('invalid_path', `Unsupported managed target entry: ${relative}`)
      // Names only. Sensitive bytes are not hashed, stored, or later treated as deletions.
      if (isSensitivePath(relative)) continue
      const hashed = await hashFile(absolute)
      files.set(relative, { path: relative, sha256: hashed.sha256, size: hashed.size, mode: '100644' })
    }
  }
  await visit(root, '')
  return files
}

function canonical(files: Map<string, BaselineFile>): string {
  return baselineDigest([...files.values()])
}

export interface PresentFile {
  path: string
  absPath: string
  sha256: string
  size: number
  binary: boolean
}

/**
 * Walk a work tree. Excluded directories with no baseline path are reported
 * once and not recursed, so they cannot become deletions. Symlinks fail closed.
 */
export async function walkPresent(
  root: string,
  baselinePaths: ReadonlySet<string>,
): Promise<{ files: Map<string, PresentFile>; omitted: string[] }> {
  const files = new Map<string, PresentFile>()
  const omitted: string[] = []
  async function visit(dir: string, prefix: string): Promise<void> {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name === '.git') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(dir, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new WorkspaceError('invalid_path', `Work tree contains a symbolic link: ${relative}`)
      if (stat.isDirectory()) {
        if (isExcludedDirectoryName(entry.name) && !baselineHasPrefix(baselinePaths, relative)) {
          omitted.push(relative)
          continue
        }
        await visit(absolute, relative)
        continue
      }
      if (!stat.isFile()) throw new WorkspaceError('invalid_path', `Unsupported work tree entry: ${relative}`)
      const hashed = await hashFile(absolute)
      files.set(relative, {
        path: relative,
        absPath: absolute,
        sha256: hashed.sha256,
        size: hashed.size,
        binary: hashed.binary,
      })
    }
  }
  await visit(root, '')
  return { files, omitted }
}

export async function diffAgainstBaseline(
  store: ArtifactStore,
  gitBin: string,
  baseline: BaselineManifest,
  workRoot: string,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  const baselinePaths = new Set(baseline.files.map((file) => file.path))
  const present = await walkPresent(workRoot, baselinePaths)
  const ignored = await frozenIgnored(store, gitBin, baseline, [...present.files.keys()])
  const files: FileChange[] = []
  const filtered: FilteredPath[] = []
  for (const path of present.omitted) filtered.push({ path, reason: 'ignored' })
  const before = new Map(baseline.files.map((file) => [file.path, file]))
  const paths = [...new Set([...before.keys(), ...present.files.keys()])].sort()
  for (const path of paths) {
    const prior = before.get(path)
    const after = present.files.get(path)
    if (!prior && after && (ignored.has(path) || isUnderExcludedDirectory(path))) {
      filtered.push({ path, reason: 'ignored' })
      continue
    }
    if (isSensitivePath(path)) {
      if (prior?.sha256 !== after?.sha256) filtered.push({ path, reason: 'sensitive' })
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
    if (prior && after && prior.sha256 !== after.sha256) {
      files.push(await storePresent(store, path, 'modified', after.absPath))
    }
  }
  return { files, filtered }
}

async function frozenIgnored(
  store: ArtifactStore,
  gitBin: string,
  baseline: BaselineManifest,
  paths: string[],
): Promise<Set<string>> {
  const ignoreFiles = baseline.files.filter((file) => file.path === '.gitignore' || file.path.endsWith('/.gitignore'))
  if (ignoreFiles.length === 0 || paths.length === 0) return new Set()
  const view = join(store.root, 'scratch', `ignore-${baseline.baselineId.slice(0, 12)}`)
  const { rm } = await import('node:fs/promises')
  await rm(view, { recursive: true, force: true })
  for (const file of ignoreFiles) {
    const bytes = await store.getBlob(file.sha256)
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

async function storePresent(store: ArtifactStore, path: string, kind: 'added' | 'modified', absPath: string): Promise<FileChange> {
  const bytes = await readFile(absPath)
  const sha = await store.putBlob(bytes)
  if (sha256Bytes(bytes) !== sha) throw new WorkspaceError('store_corrupt', `Stored blob drifted for ${path}`)
  return { path, kind, size: bytes.length, sha256: sha, binary: looksBinary(bytes) }
}
