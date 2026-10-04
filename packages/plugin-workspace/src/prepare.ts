import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  captureFilesBaseline,
  loadBaseline,
  materializeFilesBaseline,
} from './baseline.ts'
import { WorkspaceError } from './errors.ts'
import { isExcludedDirectoryName } from './exclusions.ts'
import { isSensitivePath } from './filter.ts'
import { copyTree, removeConfirmed, writeDurable } from './fsx.ts'
import { materializeCommit } from './git-work.ts'
import { Git, assertGitRepo, resolveBranchCommit } from './git.ts'
import { estimateAllocatedBytes, measurementCluster, type StorageLedger } from './ledger.ts'
import { loadDeliveryRun, loadManifest } from './freeze.ts'
import {
  copyCommits,
  ensureBare,
  ensureGitTool,
  hasCommit,
  pinRef,
  refTarget,
  serviceGitPath,
  type GitTool,
} from './objects.ts'
import { assertAbsolutePath, assertNoOverlap, assertSafeId, isInside, safeJoin } from './paths.ts'
import { snapshotTree } from './snapshot.ts'
import type { ArtifactStore } from './store.ts'
import type { PrepareRunInput, PreparedWorkspace, RunReservationQuery, WorkspaceKind } from './types.ts'

interface GitSelection {
  branch: string | null
  baseCommit: string
  originCommit: string
}

interface ReservationPlan {
  bytes: number
  futureBytes: number
  sourceRef: string | null
  selection: GitSelection | null
  seed: Awaited<ReturnType<typeof loadManifest>> | null
  seedRun: RunRecord | null
}

export interface RunRecord {
  runId: string
  kind: WorkspaceKind
  projectRoot: string
  workspacePath: string
  baselinePath: string | null
  baseRef: string | null
  originBaseRef?: string | null
  targetBranch: string | null
  createdAt: string
  /** Phase 1 runs keep work outside the artifact store. Absent means a legacy record. */
  layout?: 'phase1'
  baselineId?: string | null
  executionPath?: string
  homePath?: string
  tmpPath?: string
  outputPath?: string
  reservationId?: string
  serviceGit?: string | null
  publishedDeliveryId?: string | null
  cleanedAt?: string | null
  /** When executionRetentionHours is non-zero, cleanup waits until this instant. */
  retainUntil?: string | null
}

export interface PrepareHost {
  executionRoot: string
  ledger: StorageLedger
  gitBin: string
}

interface ExecutionLayout {
  executionPath: string
  workspacePath: string
  homePath: string
  tmpPath: string
  outputPath: string
}

export async function prepareRun(
  store: ArtifactStore,
  host: PrepareHost,
  input: PrepareRunInput,
): Promise<PreparedWorkspace> {
  const runId = assertSafeId('runId', input.runId)
  const projectRoot = assertAbsolutePath('projectRoot', input.projectRoot)
  assertSeparated(store.root, host.executionRoot, projectRoot)
  if (await existsControl(store, runId)) {
    throw new WorkspaceError('invalid_id', `Run ${runId} already exists`)
  }
  await host.ledger.observe()
  const layout = executionLayout(host.executionRoot, runId)
  if (!(await removeConfirmed(layout.executionPath))) {
    throw new WorkspaceError('storage_unavailable', 'Execution residue could not be removed')
  }
  const plan = await planRunReservation(store, host, input)

  let reserved = false
  try {
    await host.ledger.reserve(runId, plan.bytes)
    reserved = true
    await mkdir(layout.homePath, { recursive: true })
    await mkdir(layout.tmpPath, { recursive: true })
    await mkdir(layout.outputPath, { recursive: true })
    await mkdir(layout.workspacePath, { recursive: true })
    const record = input.kind === 'git'
      ? await prepareGit(store, host, input, projectRoot, layout, plan)
      : await prepareFiles(store, host, runId, projectRoot, layout, plan)
    record.reservationId = `reserve-${runId}`
    await mkdir(store.runDir(runId), { recursive: true })
    await writeDurable(controlPath(store, runId), `${JSON.stringify(record, null, 2)}\n`)
    const executionBaseBytes = await host.ledger.measureDirectory(layout.executionPath)
    await host.ledger.materialized(runId, plan.futureBytes, executionBaseBytes)
    // Admission used the estimate. Reject and roll back when the bytes now on disk exceed it.
    await host.ledger.assertHeld()
    return {
      runId,
      kind: record.kind,
      workspacePath: record.workspacePath,
      baseRef: record.baseRef,
      targetBranch: record.targetBranch,
      projectRoot,
      baselinePath: record.baselinePath,
      baselineId: record.baselineId ?? null,
      executionPath: record.executionPath,
      homePath: record.homePath,
      tmpPath: record.tmpPath,
      outputPath: record.outputPath,
    }
  } catch (error) {
    if (reserved) {
      const executionGone = await removeConfirmed(layout.executionPath)
      const runGone = await removeConfirmed(store.runDir(runId))
      if (executionGone && runGone) {
        try {
          await host.ledger.releaseRun(runId)
        } catch (releaseError) {
          if (!isDiskCapacity(error)) throw releaseError
        }
      }
    }
    throw asStorageFailure(error)
  }
}

/** Size and source only. Does not create an execution directory or call a model. */
export async function planRunReservation(
  store: ArtifactStore,
  host: PrepareHost,
  input: RunReservationQuery,
): Promise<ReservationPlan> {
  const projectRoot = assertAbsolutePath('projectRoot', input.projectRoot)
  if (input.kind !== 'git' && input.kind !== 'files') {
    throw new WorkspaceError('unsupported_kind', `Unsupported workspace kind: ${String(input.kind)}`)
  }
  const seed = input.seedDeliveryId ? await loadManifest(store, input.seedDeliveryId) : null
  const seedRun = seed ? await loadDeliveryRun(store, seed.deliveryId) : null
  if (seed && seedRun && (seed.kind !== input.kind || resolve(seedRun.projectRoot) !== projectRoot)) {
    throw new WorkspaceError('invalid_path', 'Rework delivery belongs to a different project or workspace kind')
  }
  if (input.kind === 'git') return planGit(store, host, projectRoot, input, seed, seedRun)
  return planFiles(store, host, projectRoot, seed, seedRun)
}

async function prepareGit(
  store: ArtifactStore,
  host: PrepareHost,
  input: PrepareRunInput,
  projectRoot: string,
  layout: ExecutionLayout,
  plan: ReservationPlan,
): Promise<RunRecord> {
  const selection = plan.selection
  if (!selection) throw new WorkspaceError('store_corrupt', 'Git run is missing its selected commit')
  const tool = await ensureGitTool(store.root, host.gitBin)
  const baseCommit = selection.baseCommit
  const origin = selection.originCommit
  const bare = serviceGitPath(store.root, projectRoot)
  await ensureBare(tool, bare)
  for (const commit of [...new Set([baseCommit, origin])]) {
    if (await hasCommit(tool, bare, commit)) {
      await pinBase(tool, bare, commit)
      continue
    }
    if (!(await hasCommit(tool, projectRoot, commit))) {
      throw new WorkspaceError('store_corrupt', `Required commit ${commit} is not in the service repository or the operator repository`)
    }
    await copyCommits(tool, projectRoot, bare, [commit])
    await pinBase(tool, bare, commit)
  }
  await materializeCommit(tool, bare, baseCommit, layout.workspacePath)
  return {
    runId: input.runId,
    kind: 'git',
    projectRoot,
    workspacePath: layout.workspacePath,
    baselinePath: null,
    baselineId: null,
    baseRef: baseCommit,
    originBaseRef: origin,
    targetBranch: selection.branch,
    createdAt: new Date().toISOString(),
    layout: 'phase1',
    executionPath: layout.executionPath,
    homePath: layout.homePath,
    tmpPath: layout.tmpPath,
    outputPath: layout.outputPath,
    serviceGit: bare,
  }
}

async function prepareFiles(
  store: ArtifactStore,
  host: PrepareHost,
  runId: string,
  projectRoot: string,
  layout: ExecutionLayout,
  plan: ReservationPlan,
): Promise<RunRecord> {
  void host
  const seed = plan.seed
  const seedRun = plan.seedRun
  if (seed && seedRun?.baselineId) {
    await materializeFilesBaseline(store, seedRun.baselineId, layout.workspacePath)
    await applyDeliveryFiles(store, layout.workspacePath, seed.files)
    return baseRecord(runId, projectRoot, layout, seed.baseRef, seedRun.baselineId, null)
  }
  if (seed && seedRun?.baselinePath) {
    const original = await snapshotTree(seedRun.baselinePath)
    if (seedRun.baseRef !== `files:${original}`) {
      throw new WorkspaceError('store_corrupt', 'Rework baseline no longer matches its recorded version')
    }
    await copyTree(seedRun.baselinePath, layout.workspacePath)
    await removeSensitiveFiles(layout.workspacePath)
    if (await snapshotTree(seedRun.baselinePath) !== original) {
      throw new WorkspaceError('store_corrupt', 'Rework baseline changed while copying')
    }
    await applyDeliveryFiles(store, layout.workspacePath, seed.files)
    return baseRecord(runId, projectRoot, layout, seed.baseRef, null, seedRun.baselinePath)
  }
  if (seed) throw new WorkspaceError('store_corrupt', 'Files rework delivery has no baseline')
  const manifest = await captureFilesBaseline(store, projectRoot)
  await materializeFilesBaseline(store, manifest.baselineId, layout.workspacePath)
  return baseRecord(runId, projectRoot, layout, `files:${manifest.digest}`, manifest.baselineId, null)
}

function baseRecord(
  runId: string,
  projectRoot: string,
  layout: ExecutionLayout,
  baseRef: string | null,
  baselineId: string | null,
  baselinePath: string | null,
): RunRecord {
  return {
    runId,
    kind: 'files',
    projectRoot,
    workspacePath: layout.workspacePath,
    baselinePath,
    baselineId,
    baseRef,
    originBaseRef: null,
    targetBranch: null,
    createdAt: new Date().toISOString(),
    layout: 'phase1',
    executionPath: layout.executionPath,
    homePath: layout.homePath,
    tmpPath: layout.tmpPath,
    outputPath: layout.outputPath,
    serviceGit: null,
  }
}

async function applyDeliveryFiles(
  store: ArtifactStore,
  workspacePath: string,
  files: readonly { path: string; kind: string; sha256: string | null }[],
): Promise<void> {
  for (const file of files) {
    if (isSensitivePath(file.path)) continue
    const path = safeJoin(workspacePath, file.path)
    await assertNoSymlinkAncestor(workspacePath, file.path)
    if (file.kind === 'deleted') {
      await rm(path, { force: true })
      continue
    }
    if (!file.sha256) throw new WorkspaceError('store_corrupt', 'Rework file has no blob hash')
    const bytes = await store.getBlob(file.sha256)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
}

async function planGit(
  store: ArtifactStore,
  host: PrepareHost,
  projectRoot: string,
  input: RunReservationQuery,
  seed: ReservationPlan['seed'],
  seedRun: RunRecord | null,
): Promise<ReservationPlan> {
  const selection = await selectGit(store, host, projectRoot, input, seed)
  const bare = serviceGitPath(store.root, projectRoot)
  const cluster = await measurementCluster(projectRoot)
  let importBytes = 0
  let logical = 0
  let copiedSizes: number[] = []
  let copiedDirs = 0
  let importing = false
  for (const commit of [...new Set([selection.baseCommit, selection.originCommit])]) {
    const source = await locateCommit(host.gitBin, projectRoot, bare, commit)
    if (!source) {
      throw new WorkspaceError('store_corrupt', `Required commit ${commit} is not in the service repository or the operator repository`)
    }
    const sizes = await treeSizes(new Git(host.gitBin, source), commit)
    if (sizes.copied >= logical) {
      logical = sizes.copied
      copiedSizes = sizes.copiedSizes
      copiedDirs = sizes.copiedDirs
    }
    if (source === projectRoot) {
      importing = true
      const usage = await reachableBytesGit(new Git(host.gitBin, projectRoot), commit)
      importBytes = addBytes(importBytes, usage ?? addBytes(sizes.all, sizes.all))
    }
  }
  if (importing) {
    for (let node = 0; node < BARE_REPO_NODES; node += 1) importBytes = addBytes(importBytes, directoryCluster(cluster))
  }
  const fileAlloc = copiedSizes.reduce((sum, size) => addBytes(sum, estimateAllocatedBytes(size, cluster)), 0)
  const privateBytes = privateTreeBytes(cluster, copiedDirs, fileAlloc, false, 0, 0)
  const futureBytes = futureRoom(host, logical)
  return {
    bytes: addBytes(importBytes, privateBytes, futureBytes),
    futureBytes,
    sourceRef: selection.baseCommit,
    selection,
    seed,
    seedRun,
  }
}

async function planFiles(
  store: ArtifactStore,
  host: PrepareHost,
  projectRoot: string,
  seed: ReservationPlan['seed'],
  seedRun: RunRecord | null,
): Promise<ReservationPlan> {
  const cluster = await measurementCluster(projectRoot)
  let shape: SourceShape
  let capture = false
  if (seedRun?.baselineId) {
    const manifest = await loadBaseline(store, seedRun.baselineId)
    shape = shapeFromPaths(manifest.files.map((file) => ({ path: file.path, size: file.size })))
  } else if (seedRun?.baselinePath) {
    shape = await measureSourceShape(seedRun.baselinePath)
  } else if (seed) {
    throw new WorkspaceError('store_corrupt', 'Files rework delivery has no baseline')
  } else {
    capture = true
    shape = await measureSourceShape(projectRoot)
  }
  const futureBytes = futureRoom(host, shape.logical)
  const fileAlloc = shape.sizes.reduce((sum, size) => addBytes(sum, estimateAllocatedBytes(size, cluster)), 0)
  const privateBytes = privateTreeBytes(cluster, shape.directories, fileAlloc, capture, shape.sizes.length, fileAlloc)
  return {
    bytes: addBytes(privateBytes, futureBytes),
    futureBytes,
    sourceRef: seed?.baseRef ?? null,
    selection: null,
    seed,
    seedRun,
  }
}

async function selectGit(
  store: ArtifactStore,
  host: PrepareHost,
  projectRoot: string,
  input: RunReservationQuery,
  seed: ReservationPlan['seed'],
): Promise<GitSelection> {
  const operator = new Git(host.gitBin, projectRoot)
  await assertGitRepo(operator)
  const resolved = await resolveBranchCommit(operator, input.targetBranch)
  const pinned = input.pinnedBaseRef ? normalizePinnedCommit(input.pinnedBaseRef) : null
  if (pinned) {
    const bare = serviceGitPath(store.root, projectRoot)
    const present = await locateCommit(host.gitBin, projectRoot, bare, pinned)
    if (!present) {
      throw new WorkspaceError('store_corrupt', `Pinned commit ${pinned} is not in the operator or service repository`)
    }
  }
  const branchCommit = pinned ?? resolved.commit
  if (seed && !seed.gitCommit) throw new WorkspaceError('store_corrupt', 'Git rework delivery has no commit')
  const baseCommit = seed?.gitCommit ?? branchCommit
  const originCommit = seed ? (seed.originBaseRef ?? seed.baseRef ?? branchCommit) : branchCommit
  if (!baseCommit || !originCommit) throw new WorkspaceError('store_corrupt', 'Git run is missing a base commit')
  return { branch: resolved.branch, baseCommit, originCommit }
}

function normalizePinnedCommit(value: string): string {
  const commit = value.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit) && !/^[0-9a-f]{64}$/.test(commit)) {
    throw new WorkspaceError('invalid_id', 'pinnedBaseRef must be a git commit id')
  }
  return commit
}

async function locateCommit(gitBin: string, projectRoot: string, bare: string, commit: string): Promise<string | null> {
  if (await directoryExists(bare) && await commitPresent(new Git(gitBin, bare), commit)) return bare
  if (await commitPresent(new Git(gitBin, projectRoot), commit)) return projectRoot
  return null
}

async function directoryExists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises')
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function commitPresent(git: Git, commit: string): Promise<boolean> {
  const result = await git.run(['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true })
  return result.code === 0
}

async function treeSizes(git: Git, commit: string): Promise<{ copied: number; all: number; copiedSizes: number[]; copiedDirs: number }> {
  const result = await git.run(['ls-tree', '-r', '-l', commit])
  let copied = 0
  let all = 0
  const copiedSizes: number[] = []
  const dirs = new Set<string>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const path = line.slice(tab + 1).replace(/\\/g, '/')
    const size = Number(line.slice(0, tab).split(' ').at(-1))
    if (!Number.isInteger(size) || size < 0) continue
    all = addBytes(all, size)
    if (isSensitivePath(path)) continue
    copied = addBytes(copied, size)
    copiedSizes.push(size)
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  return { copied, all, copiedSizes, copiedDirs: dirs.size }
}

async function reachableBytesGit(git: Git, commit: string): Promise<number | null> {
  const result = await git.run(['rev-list', '--disk-usage', '--objects', commit], { allowFailure: true })
  if (result.code !== 0) return null
  const value = Number(result.stdout.trim().split(/\s+/)[0])
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Directory and metadata nodes created around one private run. Not an exact physical size. */
const CONTROL_FILE_BYTES = 8192
const MANIFEST_ENTRY_BYTES = 512
const MANIFEST_HEADER_BYTES = 256
const BARE_REPO_NODES = 16

interface SourceShape {
  logical: number
  directories: number
  sizes: number[]
}

function directoryCluster(cluster: number): number {
  return estimateAllocatedBytes(0, cluster)
}

function privateTreeBytes(
  cluster: number,
  nestedDirs: number,
  workFileAlloc: number,
  capture: boolean,
  captureCount: number,
  captureAlloc: number,
): number {
  // execution root, run, box, work, state, home, tmp, output, runs and control directory.
  let nodes = 10 + nestedDirs
  let bytes = addBytes(workFileAlloc, estimateAllocatedBytes(CONTROL_FILE_BYTES, cluster))
  if (capture) {
    nodes += 4 + captureCount
    bytes = addBytes(
      bytes,
      captureAlloc,
      estimateAllocatedBytes(MANIFEST_HEADER_BYTES + captureCount * MANIFEST_ENTRY_BYTES, cluster),
    )
  }
  for (let index = 0; index < nodes; index += 1) bytes = addBytes(bytes, directoryCluster(cluster))
  return bytes
}

async function measureSourceShape(root: string): Promise<SourceShape> {
  const { lstat, readdir } = await import('node:fs/promises')
  const sizes: number[] = []
  let directories = 0
  let logical = 0
  const stack: { dir: string; prefix: string }[] = [{ dir: root, prefix: '' }]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      throw new WorkspaceError('storage_unavailable', `Could not measure ${current.dir}`, error)
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name === '.git') continue
      const path = join(current.dir, entry.name)
      const relative = current.prefix ? `${current.prefix}/${entry.name}` : entry.name
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        throw new WorkspaceError('storage_unavailable', `Could not measure ${path}`, error)
      }
      if (info.isSymbolicLink()) throw new WorkspaceError('invalid_path', `Managed target contains a symbolic link: ${path}`)
      if (info.isDirectory()) {
        if (isExcludedDirectoryName(entry.name) || isSensitivePath(relative)) continue
        directories += 1
        stack.push({ dir: path, prefix: relative })
        continue
      }
      if (!info.isFile()) throw new WorkspaceError('invalid_path', `Unsupported managed target entry: ${path}`)
      if (isSensitivePath(relative)) continue
      logical = addBytes(logical, info.size)
      sizes.push(info.size)
    }
  }
  return { logical, directories, sizes }
}

function shapeFromPaths(files: readonly { path: string; size: number }[]): SourceShape {
  const dirs = new Set<string>()
  const sizes: number[] = []
  let logical = 0
  for (const file of files) {
    if (isSensitivePath(file.path)) continue
    const size = file.size > 0 ? file.size : 0
    logical = addBytes(logical, size)
    sizes.push(size)
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  return { logical, directories: dirs.size, sizes }
}

async function removeSensitiveFiles(root: string): Promise<void> {
  const { lstat, readdir, rm } = await import('node:fs/promises')
  const base = resolve(root)
  const stack = [base]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name === '.git') continue
      const path = join(current, entry.name)
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (info.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!info.isFile()) continue
      const relative = path.slice(base.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
      if (isSensitivePath(relative)) await rm(path, { force: true })
    }
  }
}

function futureRoom(host: PrepareHost, logical: number): number {
  const policy = host.ledger.currentPolicy()
  return addBytes(Math.max(policy.defaultRunReserveBytes, logical), policy.artifactPublishReserveBytes)
}

function addBytes(...parts: number[]): number {
  let total = 0
  for (const part of parts) {
    if (!Number.isInteger(part) || part < 0) {
      throw new WorkspaceError('disk_capacity', 'Reservation size is invalid')
    }
    total += part
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER
  }
  return total
}

async function pinBase(tool: GitTool, bare: string, commit: string): Promise<void> {
  const ref = `refs/lachesis/bases/${commit}`
  const current = await refTarget(tool, bare, ref)
  if (current === commit) return
  if (current) throw new WorkspaceError('store_corrupt', `Base pin ${ref} points at a different commit`)
  await pinRef(tool, bare, ref, commit)
}

function executionLayout(executionRoot: string, runId: string): ExecutionLayout {
  const executionPath = join(executionRoot, runId)
  return {
    executionPath,
    workspacePath: join(executionPath, 'box', 'work'),
    homePath: join(executionPath, 'box', 'state', 'home'),
    tmpPath: join(executionPath, 'tmp'),
    outputPath: join(executionPath, 'box', 'state', 'output'),
  }
}

function assertSeparated(storeRoot: string, executionRoot: string, projectRoot: string): void {
  assertNoOverlap(storeRoot, projectRoot)
  assertNoOverlap(executionRoot, projectRoot)
  if (isInside(storeRoot, projectRoot) || isInside(executionRoot, projectRoot)) {
    throw new WorkspaceError('invalid_path', 'projectRoot must not contain or live inside service storage')
  }
  if (isInside(storeRoot, executionRoot) || isInside(executionRoot, storeRoot)) {
    throw new WorkspaceError('invalid_path', 'execution root and the artifact store must be separate directories')
  }
}

async function existsControl(store: ArtifactStore, runId: string): Promise<boolean> {
  const { access } = await import('node:fs/promises')
  for (const path of [controlPath(store, runId), join(store.runDir(runId), 'meta.json')]) {
    try {
      await access(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return false
}

export function controlPath(store: ArtifactStore, runId: string): string {
  return join(store.runDir(runId), 'control.json')
}

export async function loadRun(store: ArtifactStore, runId: string): Promise<RunRecord> {
  try {
    return await store.readJson<RunRecord>(controlPath(store, runId))
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error
    return store.readJson<RunRecord>(join(store.runDir(runId), 'meta.json'))
  }
}

async function assertNoSymlinkAncestor(root: string, posixPath: string): Promise<void> {
  let current = root
  for (const segment of posixPath.split('/')) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WorkspaceError('invalid_path', `Rework path uses a symbolic link: ${posixPath}`)
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function isDiskCapacity(error: unknown): boolean {
  if (error instanceof WorkspaceError) return error.code === 'disk_capacity'
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'disk_capacity')
}

function asStorageFailure(error: unknown): unknown {
  if (error instanceof WorkspaceError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new WorkspaceError('storage_full', 'Storage is full. The run was not started and no checkpoint was written.')
  }
  return error
}

export async function saveRun(store: ArtifactStore, run: RunRecord): Promise<void> {
  await mkdir(store.runDir(run.runId), { recursive: true })
  await writeDurable(controlPath(store, run.runId), `${JSON.stringify(run, null, 2)}\n`)
}
