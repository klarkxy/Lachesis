import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Evidence } from './types.ts'
import { WorkspaceError } from './errors.ts'
import { materializeFilesBaseline } from './baseline.ts'
import { copyTree, emptyDirKeepGit, posixJoin, rmRetry } from './fsx.ts'
import { Git, assertGitRepo, resolveBranchCommit } from './git.ts'
import { hashFile } from './hash.ts'
import { loadDeliveryRun, loadManifest } from './freeze.ts'
import { copyCommits, ensureGitTool, hasCommit, initWorkRepo, serviceGitPath } from './objects.ts'
import type { RunRecord } from './prepare.ts'
import type { ArtifactStore } from './store.ts'
import type { FileChange, FrozenManifest, IntegrateInput, IntegrationOutcome } from './types.ts'
import { runVerification } from './verify.ts'
import { walkFiles } from './walk.ts'
import { snapshotTree } from './snapshot.ts'

export interface TouchedFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  oursSha256: string | null
  resultSha256: string | null
}

export interface IntegrationRecord {
  applicationId: string
  deliveryId: string
  kind: FrozenManifest['kind']
  projectRoot: string
  integrationPath: string
  expectedTarget: string | null
  targetBranch: string | null
  resultTarget: string | null
  status: IntegrationOutcome['status']
  conflictPaths: string[]
  touched: TouchedFile[]
  diagnostic: string | null
  targetDigest?: string
  /** False when the candidate repo is private to the artifact store. Absent means a legacy operator worktree. */
  linkedWorktree?: boolean
}

export async function integrate(
  store: ArtifactStore,
  gitBin: string,
  input: IntegrateInput,
): Promise<IntegrationOutcome> {
  const manifest = await loadManifest(store, input.deliveryId)
  const run = await loadDeliveryRun(store, input.deliveryId)
  const projectRoot = input.projectRoot
  const integrationPath = join(store.integrationDir(input.applicationId), 'work')
  await rmRetry(integrationPath).catch(() => undefined)
  await mkdir(join(store.integrationDir(input.applicationId)), { recursive: true })

  if (manifest.kind === 'git') {
    return integrateGit(store, gitBin, input, manifest, run, projectRoot, integrationPath)
  }
  return integrateFiles(store, gitBin, input, manifest, run, projectRoot, integrationPath)
}

export async function loadIntegration(store: ArtifactStore, applicationId: string): Promise<IntegrationRecord> {
  return store.readJson<IntegrationRecord>(join(store.integrationDir(applicationId), 'meta.json'))
}

async function integrateGit(
  store: ArtifactStore,
  gitBin: string,
  input: IntegrateInput,
  manifest: FrozenManifest,
  run: RunRecord,
  projectRoot: string,
  integrationPath: string,
): Promise<IntegrationOutcome> {
  if (!manifest.gitCommit) throw new WorkspaceError('store_corrupt', 'Git delivery is missing a commit')
  const git = new Git(gitBin, projectRoot)
  await assertGitRepo(git)
  const latest = await resolveBranchCommit(git, input.targetBranch)
  const phase1 = run.layout === 'phase1'
  if (phase1) {
    const tool = await ensureGitTool(store.root, gitBin)
    const bare = run.serviceGit ?? serviceGitPath(store.root, run.projectRoot)
    if (!(await hasCommit(tool, bare, manifest.gitCommit))) {
      throw new WorkspaceError('store_corrupt', 'Delivery commit is not retained in the service repository')
    }
    await rmRetry(integrationPath).catch(() => undefined)
    await initWorkRepo(tool, integrationPath)
    await copyCommits(tool, projectRoot, integrationPath, [latest.commit])
    await copyCommits(tool, bare, integrationPath, [manifest.gitCommit])
  } else {
    await git.run(['worktree', 'remove', '--force', integrationPath], { allowFailure: true })
    await git.run(['worktree', 'prune'], { allowFailure: true })
    await rmRetry(integrationPath).catch(() => undefined)
    await git.run(['worktree', 'add', '--detach', integrationPath, latest.commit])
  }
  const ig = new Git(gitBin, integrationPath)
  if (phase1) await ig.run(['checkout', '--detach', latest.commit])
  const linkedWorktree = !phase1
  const merge = await ig.run(['merge', '--no-edit', '--no-ff', manifest.gitCommit], { allowFailure: true })
  const conflictPaths = await unmergedPaths(ig)
  const evidence: Evidence[] = [{
    kind: 'lifecycle',
    label: 'three-way merge',
    outcome: conflictPaths.length > 0 ? 'failed' : merge.code === 0 ? 'passed' : 'failed',
    detail: summarize(merge.stdout, merge.stderr),
  }]

  if (conflictPaths.length > 0) {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'conflict',
      expectedTarget: latest.commit,
      targetBranch: latest.branch,
      resultTarget: null,
      diagnostic: `Merge conflict in ${conflictPaths.join(', ')}`,
      evidence,
      conflictPaths,
      touched: [],
      linkedWorktree,
    })
  }

  if (merge.code !== 0) {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'failed',
      expectedTarget: latest.commit,
      targetBranch: latest.branch,
      resultTarget: null,
      diagnostic: summarize(merge.stdout, merge.stderr) || 'git merge failed',
      evidence,
      conflictPaths: [],
      touched: [],
      linkedWorktree,
    })
  }

  // Textually clean merges still run project verification.
  const verification = await runVerification(integrationPath, input.verificationCommand, input.verificationTimeoutMs,
    join(store.integrationDir(input.applicationId), 'verification.json'))
  evidence.push(verification)
  const resultTarget = await ig.text(['rev-parse', 'HEAD'])
  if (verification.outcome === 'failed') {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'failed',
      expectedTarget: latest.commit,
      targetBranch: latest.branch,
      resultTarget,
      diagnostic: verification.detail,
      evidence,
      conflictPaths: [],
      touched: [],
      linkedWorktree,
    })
  }
  return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
    status: 'ready',
    expectedTarget: latest.commit,
    targetBranch: latest.branch,
    resultTarget,
    diagnostic: null,
    evidence,
    conflictPaths: [],
    touched: [],
    linkedWorktree,
  })
}

async function integrateFiles(
  store: ArtifactStore,
  gitBin: string,
  input: IntegrateInput,
  manifest: FrozenManifest,
  run: RunRecord,
  projectRoot: string,
  integrationPath: string,
): Promise<IntegrationOutcome> {
  await mkdir(integrationPath, { recursive: true })
  if (run.baselineId) await materializeFilesBaseline(store, run.baselineId, integrationPath)
  else if (run.baselinePath) await copyTree(run.baselinePath, integrationPath)
  else throw new WorkspaceError('store_corrupt', 'Files delivery is missing a baseline')
  const git = new Git(gitBin, integrationPath)
  await git.run(['init', '-b', 'lachesis'])
  await git.run(['config', 'core.autocrlf', 'false'])
  await git.run(['add', '-A'])
  await git.run(['commit', '--allow-empty', '-m', 'lachesis-baseline'])
  const base = await git.text(['rev-parse', 'HEAD'])

  await git.run(['checkout', '-b', 'delivery'])
  await applyChangesToDir(integrationPath, manifest.files, store)
  await git.run(['add', '-A'])
  await git.run(['commit', '--allow-empty', '-m', 'lachesis-delivery'])
  const delivery = await git.text(['rev-parse', 'HEAD'])

  await git.run(['checkout', '-B', 'target', base])
  await emptyDirKeepGit(integrationPath)
  const targetDigest = await snapshotTree(projectRoot)
  await copyTree(projectRoot, integrationPath)
  if (await snapshotTree(integrationPath) !== targetDigest ||
      await snapshotTree(projectRoot) !== targetDigest) {
    throw new WorkspaceError('target_mismatch', 'Target changed during integration snapshot')
  }
  await git.run(['add', '-A'])
  await git.run(['commit', '--allow-empty', '-m', 'lachesis-target'])
  const target = await git.text(['rev-parse', 'HEAD'])

  const merge = await git.run(['merge', '--no-edit', '--no-ff', delivery], { allowFailure: true })
  const conflictPaths = await unmergedPaths(git)
  const evidence: Evidence[] = [{
    kind: 'lifecycle',
    label: 'three-way merge',
    outcome: conflictPaths.length > 0 ? 'failed' : merge.code === 0 ? 'passed' : 'failed',
    detail: summarize(merge.stdout, merge.stderr),
  }]
  const touched = conflictPaths.length > 0 ? [] : await collectTouched(projectRoot, integrationPath)

  if (conflictPaths.length > 0) {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'conflict',
      expectedTarget: `files:${target}`,
      targetBranch: null,
      resultTarget: null,
      diagnostic: `Merge conflict in ${conflictPaths.join(', ')}`,
      evidence,
      conflictPaths,
      touched,
      targetDigest,
    })
  }
  if (merge.code !== 0) {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'failed',
      expectedTarget: `files:${target}`,
      targetBranch: null,
      resultTarget: null,
      diagnostic: summarize(merge.stdout, merge.stderr) || 'git merge failed',
      evidence,
      conflictPaths: [],
      touched,
      targetDigest,
    })
  }

  const verification = await runVerification(integrationPath, input.verificationCommand, input.verificationTimeoutMs,
    join(store.integrationDir(input.applicationId), 'verification.json'))
  evidence.push(verification)
  const resultTarget = await git.text(['rev-parse', 'HEAD'])
  if (verification.outcome === 'failed') {
    return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
      status: 'failed',
      expectedTarget: `files:${target}`,
      targetBranch: null,
      resultTarget: `files:${resultTarget}`,
      diagnostic: verification.detail,
      evidence,
      conflictPaths: [],
      touched,
      targetDigest,
    })
  }
  return persistOutcome(store, input, manifest, projectRoot, integrationPath, {
    status: 'ready',
    expectedTarget: `files:${target}`,
    targetBranch: null,
    resultTarget: `files:${resultTarget}`,
    diagnostic: null,
    evidence,
    conflictPaths: [],
    touched,
    targetDigest,
  })
}

async function persistOutcome(
  store: ArtifactStore,
  input: IntegrateInput,
  manifest: FrozenManifest,
  projectRoot: string,
  integrationPath: string,
  partial: Omit<IntegrationRecord, 'applicationId' | 'deliveryId' | 'kind' | 'projectRoot' | 'integrationPath'> & {
    evidence: Evidence[]
    linkedWorktree?: boolean
  },
): Promise<IntegrationOutcome> {
  const record: IntegrationRecord = {
    applicationId: input.applicationId,
    deliveryId: input.deliveryId,
    kind: manifest.kind,
    projectRoot,
    integrationPath,
    expectedTarget: partial.expectedTarget,
    targetBranch: partial.targetBranch,
    resultTarget: partial.resultTarget,
    status: partial.status,
    conflictPaths: partial.conflictPaths,
    touched: partial.touched,
    diagnostic: partial.diagnostic,
    ...(partial.targetDigest ? { targetDigest: partial.targetDigest } : {}),
    ...(partial.linkedWorktree === undefined ? {} : { linkedWorktree: partial.linkedWorktree }),
  }
  await store.writeJson(join(store.integrationDir(input.applicationId), 'meta.json'), record)
  await store.writeJson(join(store.integrationDir(input.applicationId), 'evidence.json'), partial.evidence)
  return {
    applicationId: input.applicationId,
    deliveryId: input.deliveryId,
    status: partial.status,
    expectedTarget: partial.expectedTarget,
    resultTarget: partial.resultTarget,
    diagnostic: partial.diagnostic,
    evidence: partial.evidence,
    conflictPaths: partial.conflictPaths,
    integrationPath,
  }
}

export async function applyChangesToDir(dir: string, files: FileChange[], store: ArtifactStore): Promise<void> {
  for (const file of files) {
    const abs = posixJoin(dir, file.path)
    if (file.kind === 'deleted') {
      await rmRetry(abs)
      continue
    }
    if (!file.sha256) continue
    const bytes = await store.getBlob(file.sha256)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
  }
}

async function unmergedPaths(git: Git): Promise<string[]> {
  const lines = await git.lines(['diff', '--name-only', '--diff-filter=U'])
  return [...new Set(lines.map((line) => line.replace(/\\/g, '/')))].filter((line) => line.length > 0)
}

async function collectTouched(oursRoot: string, resultRoot: string): Promise<TouchedFile[]> {
  const ours = await hashMap(oursRoot)
  const result = await hashMap(resultRoot)
  const paths = [...new Set([...ours.keys(), ...result.keys()])].sort()
  const touched: TouchedFile[] = []
  for (const path of paths) {
    const a = ours.get(path) ?? null
    const b = result.get(path) ?? null
    if (a === b) continue
    if (a === null && b !== null) touched.push({ path, kind: 'added', oursSha256: null, resultSha256: b })
    else if (a !== null && b === null) touched.push({ path, kind: 'deleted', oursSha256: a, resultSha256: null })
    else touched.push({ path, kind: 'modified', oursSha256: a, resultSha256: b })
  }
  return touched
}

async function hashMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const file of await walkFiles(root)) {
    map.set(file.posixPath, (await hashFile(file.absPath)).sha256)
  }
  return map
}

function summarize(stdout: string, stderr: string): string | null {
  const text = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n')
  return text.length > 0 ? text.slice(0, 4_000) : null
}
