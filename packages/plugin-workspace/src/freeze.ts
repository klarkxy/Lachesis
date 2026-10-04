import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { diffAgainstBaseline, loadBaseline } from './baseline.ts'
import { WorkspaceError } from './errors.ts'
import { gitIgnoredPaths, isSensitivePath } from './filter.ts'
import { Git } from './git.ts'
import { diffGitWork } from './git-work.ts'
import { hashFile, looksBinary, manifestSha256 } from './hash.ts'
import { rmRetry, syncDirectory, writeDurable, type DurabilityLevel } from './fsx.ts'
import type { StorageLedger } from './ledger.ts'
import { commitDeliveryTree, ensureGitTool, pinRef, serviceGitPath } from './objects.ts'
import { assertSafeId, toPosix } from './paths.ts'
import { saveRun, type RunRecord } from './prepare.ts'
import type { ArtifactStore } from './store.ts'
import type { FileChange, FilteredPath, FrozenManifest, FreezeDeliveryInput } from './types.ts'
import { walkFiles } from './walk.ts'
import { assertWorkerStopped } from './worker.ts'

export async function freezeDelivery(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  input: FreezeDeliveryInput,
  ledger?: StorageLedger,
): Promise<FrozenManifest> {
  await assertWorkerStopped(input.worker)
  if (run.layout === 'phase1') {
    if (!ledger) throw new WorkspaceError('storage_unavailable', 'Phase 1 publication requires the storage ledger')
    return publishPhase1(store, gitBin, run, input, ledger)
  }
  return publishLegacy(store, gitBin, run, input)
}

async function publishPhase1(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  input: FreezeDeliveryInput,
  ledger: StorageLedger,
): Promise<FrozenManifest> {
  const deliveryId = assertSafeId('deliveryId', input.deliveryId)
  await assertDeliveryAvailable(store, deliveryId)
  await ledger.assertHeld()
  const { files, filtered } = await collectChanges(store, gitBin, run)
  let gitCommit: string | null = null
  if (run.kind === 'git') {
    if (!run.baseRef) throw new WorkspaceError('store_corrupt', 'Git run is missing baseRef')
    const tool = await ensureGitTool(store.root, gitBin)
    const bare = run.serviceGit ?? serviceGitPath(store.root, run.projectRoot)
    gitCommit = await commitDeliveryTree(
      tool,
      bare,
      run.baseRef,
      run.originBaseRef ?? run.baseRef,
      files,
      deliveryId,
      join(store.runDir(run.runId), `delivery-${deliveryId}.index`),
      store,
    )
    await pinRef(tool, bare, `refs/lachesis/deliveries/${deliveryId}`, gitCommit)
  }
  const manifest: FrozenManifest = {
    deliveryId,
    runId: run.runId,
    kind: run.kind,
    baseRef: run.baseRef,
    originBaseRef: run.kind === 'git' ? (run.originBaseRef ?? run.baseRef) : null,
    files,
    filtered,
    manifestSha256: manifestSha256(files),
    gitCommit,
    createdAt: new Date().toISOString(),
  }
  const published = await publishSnapshot(store, store.deliveryDir(deliveryId), store.stagingDir(deliveryId), manifest, run)
  // Artifact-ready keeps the reservation and the execution directory.
  // Domain.completeRun records the committed delivery. disposeRun is the release.
  await ledger.markPublished(run.runId)
  await saveRun(store, { ...run, publishedDeliveryId: deliveryId })
  return published
}

async function publishLegacy(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  input: FreezeDeliveryInput,
): Promise<FrozenManifest> {
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

async function readPublication<T>(store: ArtifactStore, id: string, fileName: string): Promise<T> {
  try {
    return await store.readJson<T>(join(store.deliveryDir(id), fileName))
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error
    return store.readJson<T>(join(store.checkpointDir(id), fileName))
  }
}

export async function loadManifest(store: ArtifactStore, deliveryId: string): Promise<FrozenManifest> {
  const manifest = await readPublication<FrozenManifest>(store, deliveryId, 'manifest.json')
  if (manifest.manifestSha256 !== manifestSha256(manifest.files ?? [])) {
    throw new WorkspaceError('store_corrupt', `Delivery ${deliveryId} manifest does not match its files`)
  }
  return manifest
}

export async function loadDeliveryRun(store: ArtifactStore, deliveryId: string): Promise<RunRecord> {
  return readPublication<RunRecord>(store, deliveryId, 'run.json')
}

async function collectChanges(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
): Promise<{ files: FileChange[]; filtered: FilteredPath[] }> {
  if (run.layout === 'phase1' && run.kind === 'git') {
    const origin = run.originBaseRef ?? run.baseRef
    if (!origin) throw new WorkspaceError('store_corrupt', 'Git run is missing baseRef')
    const tool = await ensureGitTool(store.root, gitBin)
    return diffGitWork(store, tool, gitBin, run.serviceGit ?? serviceGitPath(store.root, run.projectRoot), origin, run.workspacePath)
  }
  if (run.layout === 'phase1' && run.kind === 'files' && run.baselineId) {
    return diffAgainstBaseline(store, gitBin, await loadBaseline(store, run.baselineId), run.workspacePath)
  }
  if (run.kind === 'git') return collectGitDiff(store, gitBin, run)
  if (run.kind === 'files') {
    if (!run.baselinePath) throw new WorkspaceError('store_corrupt', 'Files run is missing a baseline path')
    return collectFilesDiff(store, gitBin, run)
  }
  throw new WorkspaceError('unsupported_kind', `Unsupported kind ${String(run.kind)}`)
}

async function assertDeliveryAvailable(store: ArtifactStore, deliveryId: string): Promise<void> {
  const { access } = await import('node:fs/promises')
  try {
    await access(store.deliveryDir(deliveryId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new WorkspaceError('invalid_id', `Delivery ${deliveryId} already exists`)
}

async function publishSnapshot(
  store: ArtifactStore,
  dest: string,
  staging: string,
  manifest: FrozenManifest,
  run: RunRecord,
): Promise<FrozenManifest> {
  await rmRetry(staging).catch(() => undefined)
  await mkdir(staging, { recursive: true })
  let durability: DurabilityLevel = await writeDurable(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const recorded: FrozenManifest = { ...manifest, durability }
  durability = await writeDurable(join(staging, 'manifest.json'), `${JSON.stringify(recorded, null, 2)}\n`)
  recorded.durability = durability
  if (durability !== manifest.durability) {
    await writeDurable(join(staging, 'manifest.json'), `${JSON.stringify(recorded, null, 2)}\n`)
  }
  await writeDurable(join(staging, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  await mkdir(dirname(dest), { recursive: true })
  try {
    await rename(staging, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new WorkspaceError('invalid_id', `Delivery ${manifest.deliveryId} already exists`)
    }
    const mapped = code === 'ENOSPC' || code === 'EDQUOT'
      ? new WorkspaceError('storage_full', 'Storage filled during publication. The delivery was not published.')
      : error
    throw mapped
  }
  await syncDirectory(dirname(dest))
  const readBack = await store.readJson<FrozenManifest>(join(dest, 'manifest.json'))
  if (readBack.manifestSha256 !== manifestSha256(readBack.files ?? [])) {
    throw new WorkspaceError('store_corrupt', 'Published manifest hash does not match its files')
  }
  return readBack
}

export async function writeCheckpoint(
  store: ArtifactStore,
  gitBin: string,
  run: RunRecord,
  checkpointId: string,
  ledger: StorageLedger,
): Promise<FrozenManifest> {
  const id = assertSafeId('checkpointId', checkpointId)
  await ledger.assertHeld()
  const dest = store.checkpointDir(id)
  const { access } = await import('node:fs/promises')
  try {
    await access(dest)
    throw new WorkspaceError('invalid_id', `Checkpoint ${id} already exists`)
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { files, filtered } = await collectChanges(store, gitBin, run)
  let gitCommit: string | null = null
  if (run.kind === 'git' && run.baseRef) {
    const tool = await ensureGitTool(store.root, gitBin)
    const bare = run.serviceGit ?? serviceGitPath(store.root, run.projectRoot)
    gitCommit = await commitDeliveryTree(
      tool, bare, run.baseRef, run.originBaseRef ?? run.baseRef, files, id,
      join(store.runDir(run.runId), `checkpoint-${id}.index`), store,
    )
    await pinRef(tool, bare, `refs/lachesis/checkpoints/${id}`, gitCommit)
  }
  const manifest: FrozenManifest = {
    deliveryId: id,
    runId: run.runId,
    kind: run.kind,
    baseRef: run.baseRef,
    originBaseRef: run.kind === 'git' ? (run.originBaseRef ?? run.baseRef) : null,
    files,
    filtered,
    manifestSha256: manifestSha256(files),
    gitCommit,
    createdAt: new Date().toISOString(),
  }
  return publishSnapshot(store, dest, store.stagingDir(`checkpoint-${id}`), manifest, run)
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
