import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { copyTree } from './fsx.ts'
import { Git, assertGitRepo, resolveBranchCommit } from './git.ts'
import { assertAbsolutePath, assertNoOverlap, assertSafeId, safeJoin } from './paths.ts'
import { loadDeliveryRun, loadManifest } from './freeze.ts'
import type { ArtifactStore } from './store.ts'
import type { PrepareRunInput, PreparedWorkspace, WorkspaceKind } from './types.ts'
import { snapshotTree } from './snapshot.ts'

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
}

export async function prepareRun(
  store: ArtifactStore,
  gitBin: string,
  input: PrepareRunInput,
): Promise<PreparedWorkspace> {
  const runId = assertSafeId('runId', input.runId)
  const projectRoot = assertAbsolutePath('projectRoot', input.projectRoot)
  assertNoOverlap(store.root, projectRoot)
  const runDir = store.runDir(runId)
  const workspacePath = join(runDir, 'work')
  await mkdir(runDir, { recursive: true })
  const seed = input.seedDeliveryId ? await loadManifest(store, input.seedDeliveryId) : null
  const seedRun = seed ? await loadDeliveryRun(store, seed.deliveryId) : null
  if (seed) {
    if (seed.kind !== input.kind || resolve(seedRun!.projectRoot) !== projectRoot) {
      throw new WorkspaceError('invalid_path', 'Rework delivery belongs to a different project or workspace kind')
    }
  }

  if (input.kind === 'git') {
    const git = new Git(gitBin, projectRoot)
    await assertGitRepo(git)
    const resolved = await resolveBranchCommit(git, input.targetBranch)
    const baseCommit = seed?.gitCommit ?? resolved.commit
    if (seed && !seed.gitCommit) throw new WorkspaceError('store_corrupt', 'Git rework delivery has no commit')
    await git.run(['worktree', 'add', '--detach', workspacePath, baseCommit])
    const record: RunRecord = {
      runId,
      kind: 'git',
      projectRoot,
      workspacePath,
      baselinePath: null,
      baseRef: baseCommit,
      originBaseRef: seed ? (seed.originBaseRef ?? seed.baseRef) : resolved.commit,
      targetBranch: resolved.branch,
      createdAt: new Date().toISOString(),
    }
    await store.writeJson(join(runDir, 'meta.json'), record)
    return {
      runId,
      kind: 'git',
      workspacePath,
      baseRef: baseCommit,
      targetBranch: resolved.branch,
      projectRoot,
      baselinePath: null,
    }
  }

  if (input.kind !== 'files') {
    throw new WorkspaceError('unsupported_kind', `Unsupported workspace kind: ${String(input.kind)}`)
  }

  const baselinePath = join(runDir, 'baseline')
  if (seedRun && !seedRun.baselinePath) {
    throw new WorkspaceError('store_corrupt', 'Files rework delivery has no original baseline')
  }
  if (seedRun) {
    const original = await snapshotTree(seedRun.baselinePath!)
    if (seedRun.baseRef !== `files:${original}`) {
      throw new WorkspaceError('store_corrupt', 'Rework baseline no longer matches its recorded version')
    }
    await copyTree(seedRun.baselinePath!, baselinePath)
    if (await snapshotTree(baselinePath) !== original ||
        await snapshotTree(seedRun.baselinePath!) !== original) {
      throw new WorkspaceError('store_corrupt', 'Rework baseline changed while copying')
    }
  } else {
    let copied = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await snapshotTree(projectRoot)
      await rm(baselinePath, { recursive: true, force: true })
      await copyTree(projectRoot, baselinePath)
      const baseline = await snapshotTree(baselinePath)
      const after = await snapshotTree(projectRoot)
      if (before === baseline && baseline === after) { copied = true; break }
    }
    if (!copied) throw new WorkspaceError('target_mismatch', 'Target changed during baseline snapshot')
  }
  await copyTree(baselinePath, workspacePath)
  if (seed) {
    for (const file of seed.files) {
      const path = safeJoin(workspacePath, file.path)
      await assertNoSymlinkAncestor(workspacePath, file.path)
      if (file.kind === 'deleted') {
        await rm(path, { force: true })
      } else {
        if (!file.sha256) throw new WorkspaceError('store_corrupt', 'Rework file has no blob hash')
        const bytes = await store.getBlob(file.sha256)
        const actual = (await import('./hash.ts')).sha256Bytes(bytes)
        if (actual !== file.sha256) throw new WorkspaceError('store_corrupt', 'Rework blob hash changed')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes)
      }
    }
  }
  const digest = await snapshotTree(baselinePath)
  const record: RunRecord = {
    runId,
    kind: 'files',
    projectRoot,
    workspacePath,
    baselinePath,
    baseRef: `files:${digest}`,
    originBaseRef: null,
    targetBranch: null,
    createdAt: new Date().toISOString(),
  }
  await store.writeJson(join(runDir, 'meta.json'), record)
  return {
    runId,
    kind: 'files',
    workspacePath,
    baseRef: record.baseRef,
    targetBranch: null,
    projectRoot,
    baselinePath,
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function loadRun(store: ArtifactStore, runId: string): Promise<RunRecord> {
  return store.readJson<RunRecord>(join(store.runDir(runId), 'meta.json'))
}
