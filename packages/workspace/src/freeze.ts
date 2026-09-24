import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { gitIgnoredPaths, isSensitivePath } from './filter.ts'
import { Git } from './git.ts'
import { hashFile, looksBinary } from './hash.ts'
import { rmRetry } from './fsx.ts'
import { assertSafeId, toPosix } from './paths.ts'
import type { ArtifactStore } from './store.ts'
import type { FileChange, FilteredPath, FrozenManifest, FreezeDeliveryInput } from './types.ts'
import { walkFiles } from './walk.ts'
import { assertWorkerStopped } from './worker.ts'
import type { RunRecord } from './prepare.ts'

export async function freezeDelivery(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  input: FreezeDeliveryInput,
): Promise<FrozenManifest> {
  await assertWorkerStopped(input.worker)
  const deliveryId = assertSafeId('deliveryId', input.deliveryId)
  const dir = store.deliveryDir(deliveryId)
  await mkdir(dirname(dir), { recursive: true })
  try {
    // Exclusive directory creation reserves the ID before any Git ref or
    // manifest is written. A repeated freeze can never replace either.
    await mkdir(dir)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new WorkspaceError('invalid_id', `Delivery ${deliveryId} already exists`)
    }
    throw error
  }
  const { files, filtered } = await collectChanges(store, gitBin, run)
  const gitCommit = run.kind === 'git'
    ? await writeDeliveryCommit(store, gitBin, run, files, deliveryId)
    : null
  const manifest: FrozenManifest = {
    deliveryId,
    runId: run.runId,
    kind: run.kind,
    baseRef: run.baseRef,
    originBaseRef: run.kind === 'git' ? (run.originBaseRef ?? run.baseRef) : null,
    files,
    filtered,
    manifestSha256: (await import('./hash.ts')).manifestSha256(files),
    gitCommit,
    createdAt: new Date().toISOString(),
  }
  await store.writeJson(join(dir, 'manifest.json'), manifest)
  await store.writeJson(join(dir, 'run.json'), run)
  return manifest
}

export async function loadManifest(store: ArtifactStore, deliveryId: string): Promise<FrozenManifest> {
  return store.readJson<FrozenManifest>(join(store.deliveryDir(deliveryId), 'manifest.json'))
}

export async function loadDeliveryRun(store: ArtifactStore, deliveryId: string): Promise<RunRecord> {
  return store.readJson<RunRecord>(join(store.deliveryDir(deliveryId), 'run.json'))
}

async function collectChanges(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  if (run.kind === 'git') return collectGitDiff(store, gitBin, run)
  if (run.kind === 'files') {
    if (!run.baselinePath) throw new WorkspaceError('store_corrupt', 'Files run is missing a baseline path')
    return collectFilesDiff(store, gitBin, run)
  }
  throw new WorkspaceError('unsupported_kind', `Unsupported kind ${String(run.kind)}`)
}

async function collectGitDiff(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  const reviewBase = run.originBaseRef ?? run.baseRef
  if (!reviewBase) throw new WorkspaceError('store_corrupt', 'Git run is missing baseRef')
  const git = new Git(gitBin, run.workspacePath)
  const base = await lsTree(git, reviewBase)
  const work = await mapWorkTree(run.workspacePath)
  const ignored = await gitIgnoredPaths(git, [...new Set([...base.keys(), ...work.keys()])])
  const files: FileChange[] = []
  const filtered: FilteredPath[] = []
  const paths = [...new Set([...base.keys(), ...work.keys()])].sort()
  for (const path of paths) {
    const inBase = base.has(path)
    const after = work.get(path)
    if (!inBase && after && ignored.has(path)) {
      filtered.push({ path, reason: 'ignored' })
      continue
    }
    if (isSensitivePath(path)) {
      let changed = Boolean(after) !== inBase
      if (!changed && after && inBase) {
        const workGitSha = await git.text(['hash-object', '--path', path, '--', after.absPath])
        changed = workGitSha !== base.get(path)
      }
      if (changed) filtered.push({ path, reason: 'sensitive' })
      continue
    }
    if (!inBase && after) {
      files.push(await storePresent(store, path, 'added', after.absPath))
      continue
    }
    if (inBase && !after) {
      files.push({ path, kind: 'deleted', size: null, sha256: null, binary: false })
      continue
    }
    if (inBase && after) {
      const workGitSha = await git.text(['hash-object', '--path', path, '--', after.absPath])
      if (workGitSha !== base.get(path)) files.push(await storePresent(store, path, 'modified', after.absPath))
    }
  }
  return { files, filtered }
}

async function collectFilesDiff(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  const baseline = await mapWorkTree(run.baselinePath!)
  const work = await mapWorkTree(run.workspacePath)
  const ignored = await filesIgnored(gitBin, run.workspacePath, [...new Set([...baseline.keys(), ...work.keys()])], store)
  const files: FileChange[] = []
  const filtered: FilteredPath[] = []
  const paths = [...new Set([...baseline.keys(), ...work.keys()])].sort()
  for (const path of paths) {
    const before = baseline.get(path)
    const after = work.get(path)
    if (!before && after && ignored.has(path)) {
      filtered.push({ path, reason: 'ignored' })
      continue
    }
    if (isSensitivePath(path)) {
      if (before?.sha256 !== after?.sha256) filtered.push({ path, reason: 'sensitive' })
      continue
    }
    if (!before && after) {
      files.push(await storePresent(store, path, 'added', after.absPath))
      continue
    }
    if (before && !after) {
      files.push({ path, kind: 'deleted', size: null, sha256: null, binary: false })
      continue
    }
    if (before && after && before.sha256 !== after.sha256) {
      files.push(await storePresent(store, path, 'modified', after.absPath))
    }
  }
  return { files, filtered }
}

interface WorkFile {
  sha256: string
  size: number
  binary: boolean
  absPath: string
}

async function mapWorkTree(root: string): Promise<Map<string, WorkFile>> {
  const map = new Map<string, WorkFile>()
  for (const file of await walkFiles(root)) {
    const hashed = await hashFile(file.absPath)
    map.set(file.posixPath, { ...hashed, absPath: file.absPath })
  }
  return map
}

async function lsTree(git: Git, spec: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const lines = await git.nulLines(['ls-tree', '-r', '-z', spec])
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab)
    const path = toPosix(line.slice(tab + 1))
    const parts = meta.split(' ')
    if (parts[1] !== 'blob' || !parts[2]) continue
    map.set(path, parts[2])
  }
  return map
}

async function storePresent(
  store: ArtifactStore,
  path: string,
  kind: 'added' | 'modified',
  absPath: string,
): Promise<FileChange> {
  const bytes = await readFile(absPath)
  const sha = await store.putBlob(bytes)
  return {
    path,
    kind,
    size: bytes.length,
    sha256: sha,
    binary: looksBinary(bytes),
  }
}

async function filesIgnored(
  gitBin: string,
  workPath: string,
  paths: string[],
  store: ArtifactStore,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const scratch = join(store.root, 'scratch', 'ignore.git')
  await mkdir(scratch, { recursive: true })
  const setup = new Git(gitBin, store.root)
  await setup.run(['init', '--bare', scratch], { allowFailure: true })
  const git = new Git(gitBin, workPath)
  return gitIgnoredPaths(git, paths, {
    GIT_DIR: scratch,
    GIT_WORK_TREE: workPath,
  })
}

async function writeDeliveryCommit(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  files: FileChange[],
  deliveryId: string,
): Promise<string> {
  if (!run.baseRef) throw new WorkspaceError('store_corrupt', 'Git run is missing baseRef')
  const git = new Git(gitBin, run.workspacePath)
  const indexFile = join(store.runDir(run.runId), `delivery-${deliveryId}.index`)
  const env = { GIT_INDEX_FILE: indexFile }
  await rmRetry(indexFile).catch(() => undefined)
  // The manifest is cumulative relative to the original project commit.
  // Build the tree from that same base, while keeping the previous delivery
  // commit as the new commit's parent for merge ancestry.
  await git.run(['read-tree', run.originBaseRef ?? run.baseRef], { env })
  for (const file of files) {
    if (file.kind === 'deleted') {
      await git.run(['update-index', '--remove', '--', file.path], { env })
      continue
    }
    if (!file.sha256) continue
    const bytes = await store.getBlob(file.sha256)
    const hashed = await git.text(['hash-object', '-w', '--path', file.path, '--stdin'], {
      env,
      input: bytes,
    })
    const mode = await fileMode(git, run.baseRef, file.path)
    await git.run(['update-index', '--add', '--cacheinfo', `${mode},${hashed},${file.path}`], { env })
  }
  const tree = await git.text(['write-tree'], { env })
  const commit = await git.text([
    'commit-tree',
    tree,
    '-p',
    run.baseRef,
    '-m',
    `lachesis-delivery ${deliveryId}`,
  ], { env })
  // A preexisting ref may belong to an older delivery whose metadata was
  // lost. Git's compare-and-swap create prevents silently redirecting it.
  await git.run(['update-ref', `refs/lachesis/deliveries/${deliveryId}`, commit, '0'.repeat(commit.length)])
  await rmRetry(indexFile).catch(() => undefined)
  return commit
}

async function fileMode(git: Git, spec: string, posixPath: string): Promise<string> {
  const result = await git.run(['ls-tree', spec, '--', posixPath], { allowFailure: true })
  const mode = result.stdout.trim().split(' ')[0]
  return mode && /^\d{6}$/.test(mode) ? mode : '100644'
}
