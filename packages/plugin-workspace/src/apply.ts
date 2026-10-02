import { existsSync } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { posixJoin, rmRetry } from './fsx.ts'
import { Git, assertGitRepo, currentBranch, worktreeClean } from './git.ts'
import { hashFile } from './hash.ts'
import { loadIntegration, type IntegrationRecord, type TouchedFile } from './integrate.ts'
import { assertAbsolutePath, assertRelativePosix } from './paths.ts'
import type { ArtifactStore } from './store.ts'
import type { ApplyInput, ApplyOutcome, Evidence } from './types.ts'
import { runVerification } from './verify.ts'
import { snapshotTree } from './snapshot.ts'

export async function applyCandidate(
  store: ArtifactStore,
  gitBin: string,
  input: ApplyInput,
): Promise<ApplyOutcome> {
  const record = await loadIntegration(store, input.applicationId)
  const logPath = join(store.applyDir(input.applicationId), 'apply.jsonl')
  const outcomePath = join(store.applyDir(input.applicationId), 'outcome.json')
  await mkdir(store.applyDir(input.applicationId), { recursive: true })
  if (existsSync(outcomePath)) return store.readJson<ApplyOutcome>(outcomePath)
  try {
    await writeFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), op: 'start',
      expectedTarget: input.expectedTarget, recorded: record.expectedTarget })}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (existsSync(outcomePath)) return store.readJson<ApplyOutcome>(outcomePath)
    throw new WorkspaceError('recovery_required',
      'A previous apply was interrupted. Its backup and log have been preserved for recovery.')
  }

  if (input.expectedTarget !== record.expectedTarget) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `expectedTarget mismatch: body=${input.expectedTarget} candidate=${record.expectedTarget}`,
      evidence: [life('expected target', 'failed', 'Target moved or the apply body does not match the candidate')],
      rollbackRef: null,
    })
  }
  if (record.status !== 'ready' || !record.resultTarget) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `Candidate is ${record.status} and cannot be applied${record.diagnostic ? `: ${record.diagnostic}` : ''}`,
      evidence: [life('apply precheck', 'failed', record.diagnostic)],
      rollbackRef: null,
    })
  }

  if (record.kind === 'git') {
    return applyGit(store, gitBin, input, record, logPath)
  }
  return applyFiles(store, input, record, logPath)
}

async function applyGit(
  store: ArtifactStore,
  gitBin: string,
  input: ApplyInput,
  record: IntegrationRecord,
  logPath: string,
): Promise<ApplyOutcome> {
  const projectRoot = assertAbsolutePath('projectRoot', record.projectRoot)
  const git = new Git(gitBin, projectRoot)
  await assertGitRepo(git)
  const branch = await currentBranch(git)
  if (branch !== record.targetBranch) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `Target branch changed: candidate=${record.targetBranch ?? '(detached)'} current=${branch ?? '(detached)'}`,
      evidence: [life('target branch', 'failed', branch)],
      rollbackRef: null,
    })
  }
  const head = await git.text(['rev-parse', 'HEAD'])
  if (head !== record.expectedTarget) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `HEAD ${head} is not expected target ${record.expectedTarget}`,
      evidence: [life('target commit', 'failed', head)],
      rollbackRef: null,
    })
  }
  if (!(await worktreeClean(git))) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: 'Project working tree is not clean',
      evidence: [life('clean worktree', 'failed', null)],
      rollbackRef: null,
    })
  }

  const rollbackRef = `refs/lachesis/rollback/${input.applicationId}`
  await git.run(['update-ref', rollbackRef, head])
  await store.writeJson(join(store.applyDir(input.applicationId), 'previous.json'), {
    head,
    rollbackRef,
    at: new Date().toISOString(),
  })
  await log(logPath, { op: 'backup-ref', rollbackRef, head })

  const merge = await git.run(['merge', '--ff-only', record.resultTarget!], { allowFailure: true })
  if (merge.code !== 0) {
    const recovered = await tryGitRestore(git, head)
    return finish(store, input, logPath, {
      status: recovered ? 'failed' : 'recovery_required',
      resultTarget: null,
      diagnostic: summarize(merge.stdout, merge.stderr) || 'fast-forward apply failed',
      evidence: [life('fast-forward', 'failed', summarize(merge.stdout, merge.stderr))],
      rollbackRef,
    })
  }

  const verification = await runVerification(projectRoot, input.verificationCommand, input.verificationTimeoutMs,
    join(store.applyDir(input.applicationId), 'verification.json'))
  if (verification.outcome === 'failed') {
    const recovered = await tryGitRestore(git, head)
    await log(logPath, { op: 'restore', recovered, head })
    return finish(store, input, logPath, {
      status: recovered ? 'failed' : 'recovery_required',
      resultTarget: recovered ? null : await git.text(['rev-parse', 'HEAD']).catch(() => null),
      diagnostic: verification.detail,
      evidence: [verification],
      rollbackRef,
    })
  }

  const resultTarget = await git.text(['rev-parse', 'HEAD'])
  await log(logPath, { op: 'applied', resultTarget })
  return finish(store, input, logPath, {
    status: 'applied',
    resultTarget,
    diagnostic: null,
    evidence: [life('fast-forward', 'passed', resultTarget), verification],
    rollbackRef,
  })
}

async function applyFiles(
  store: ArtifactStore,
  input: ApplyInput,
  record: IntegrationRecord,
  logPath: string,
): Promise<ApplyOutcome> {
  const projectRoot = assertAbsolutePath('projectRoot', record.projectRoot)
  if (!record.targetDigest) {
    return finish(store, input, logPath, {
      status: 'failed', resultTarget: null,
      diagnostic: 'Legacy candidate has no complete target version; prepare a new candidate',
      evidence: [life('target version', 'failed', 'Reprepare required')], rollbackRef: null,
    })
  }
  let currentDigest: string
  try { currentDigest = await snapshotTree(projectRoot) }
  catch (error) {
    return finish(store, input, logPath, {
      status: 'failed', resultTarget: null,
      diagnostic: error instanceof Error ? error.message : String(error),
      evidence: [life('target version', 'failed', 'Target could not be verified')], rollbackRef: null,
    })
  }
  if (currentDigest !== record.targetDigest) {
    return finish(store, input, logPath, {
      status: 'failed', resultTarget: null,
      diagnostic: 'Refusing to overwrite external changes: managed target changed after candidate verification; prepare a new candidate',
      evidence: [life('target version', 'failed', currentDigest)], rollbackRef: null,
    })
  }
  const backupRoot = join(store.applyDir(input.applicationId), 'backup')
  await rmRetry(backupRoot)
  await mkdir(backupRoot, { recursive: true })

  const external = await findExternalChanges(projectRoot, record.touched)
  if (external.length > 0) {
    await log(logPath, { op: 'external-change', paths: external })
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `Refusing to overwrite external changes: ${external.join(', ')}`,
      evidence: [life('original hash compare', 'failed', external.join(', '))],
      rollbackRef: backupRoot,
    })
  }

  const invalidCandidate = await findInvalidCandidateFiles(record)
  if (invalidCandidate.length > 0) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `Candidate file hash mismatch: ${invalidCandidate.join(', ')}`,
      evidence: [life('candidate hash compare', 'failed', invalidCandidate.join(', '))],
      rollbackRef: null,
    })
  }

  // Finish and verify every backup before touching any project file. A backup
  // failure must leave the originals untouched, never trigger restore logic.
  try {
    for (const file of record.touched) {
      assertRelativePosix('path', file.path)
      if (file.oursSha256 === null) continue
      const live = posixJoin(projectRoot, file.path)
      const backup = posixJoin(backupRoot, file.path)
      await mkdir(dirname(backup), { recursive: true })
      await copyFile(live, backup)
      if (await currentHash(backup) !== file.oursSha256) {
        throw new Error(`Backup hash mismatch: ${file.path}`)
      }
      await log(logPath, { op: 'backup', path: file.path, sha256: file.oursSha256 })
    }
  } catch (error) {
    return finish(store, input, logPath, {
      status: 'failed',
      resultTarget: null,
      diagnostic: `Backup failed before apply: ${String(error)}`,
      evidence: [life('backup', 'failed', String(error))],
      rollbackRef: backupRoot,
    })
  }

  const written: string[] = []
  try {
    for (const file of record.touched) {
      assertRelativePosix('path', file.path)
      const live = posixJoin(projectRoot, file.path)
      if (await hasSymlinkComponent(projectRoot, file.path)) throw new Error(`Target path uses a symbolic link: ${file.path}`)
      if (file.kind === 'deleted' || file.resultSha256 === null) {
        await rmRetry(live)
        await log(logPath, { op: 'delete', path: file.path })
      } else {
        const src = posixJoin(record.integrationPath, file.path)
        if (await hasSymlinkComponent(record.integrationPath, file.path)) throw new Error(`Candidate path uses a symbolic link: ${file.path}`)
        await mkdir(dirname(live), { recursive: true })
        await copyFile(src, live)
        if (await currentHash(live) !== file.resultSha256) {
          throw new Error(`Applied candidate hash mismatch: ${file.path}`)
        }
        await log(logPath, { op: 'write', path: file.path, sha256: file.resultSha256 })
      }
      written.push(file.path)
    }
  } catch (error) {
    const recovered = await restoreFiles(projectRoot, backupRoot, record.touched)
    await log(logPath, { op: 'restore', recovered, error: String(error) })
    return finish(store, input, logPath, {
      status: recovered ? 'failed' : 'recovery_required',
      resultTarget: null,
      diagnostic: error instanceof Error ? error.message : String(error),
      evidence: [life('apply write', 'failed', String(error))],
      rollbackRef: backupRoot,
    })
  }

  const verification = await runVerification(projectRoot, input.verificationCommand, input.verificationTimeoutMs,
    join(store.applyDir(input.applicationId), 'verification.json'))
  if (verification.outcome === 'failed') {
    const recovered = await restoreFiles(projectRoot, backupRoot, record.touched)
    await log(logPath, { op: 'restore', recovered, from: 'verification' })
    return finish(store, input, logPath, {
      status: recovered ? 'failed' : 'recovery_required',
      resultTarget: null,
      diagnostic: verification.detail,
      evidence: [verification],
      rollbackRef: backupRoot,
    })
  }

  await log(logPath, { op: 'applied', written })
  return finish(store, input, logPath, {
    status: 'applied',
    resultTarget: record.resultTarget,
    diagnostic: null,
    evidence: [life('file apply', 'passed', `${written.length} paths`), verification],
    rollbackRef: backupRoot,
  })
}

async function findExternalChanges(projectRoot: string, touched: TouchedFile[]): Promise<string[]> {
  const bad: string[] = []
  for (const file of touched) {
    if (await hasSymlinkComponent(projectRoot, file.path)) { bad.push(file.path); continue }
    const live = await currentHash(posixJoin(projectRoot, file.path))
    if (live !== file.oursSha256) bad.push(file.path)
  }
  return bad
}

async function findInvalidCandidateFiles(record: IntegrationRecord): Promise<string[]> {
  const bad: string[] = []
  for (const file of record.touched) {
    assertRelativePosix('path', file.path)
    if (await hasSymlinkComponent(record.integrationPath, file.path)) { bad.push(file.path); continue }
    if (file.resultSha256 === null) continue
    const candidate = posixJoin(record.integrationPath, file.path)
    if (await currentHash(candidate) !== file.resultSha256) bad.push(file.path)
  }
  return bad
}

async function currentHash(absPath: string): Promise<string | null> {
  try {
    return (await hashFile(absPath)).sha256
  } catch {
    return null
  }
}

async function hasSymlinkComponent(root: string, posixPath: string): Promise<boolean> {
  assertRelativePosix('path', posixPath)
  let current = root
  for (const segment of posixPath.split('/')) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return false
}

export async function restoreFiles(projectRoot: string, backupRoot: string, touched: TouchedFile[]): Promise<boolean> {
  try {
    // Validate the complete backup set before mutating the target. In
    // particular, an absent backup is never interpreted as an absent original.
    for (const file of touched) {
      if (file.oursSha256 === null) continue
      if (await hasSymlinkComponent(backupRoot, file.path)) return false
      const backup = posixJoin(backupRoot, file.path)
      if (await currentHash(backup) !== file.oursSha256) return false
    }
    for (const file of touched) {
      if (await hasSymlinkComponent(projectRoot, file.path)) return false
      const live = posixJoin(projectRoot, file.path)
      if (file.oursSha256 !== null) {
        const backup = posixJoin(backupRoot, file.path)
        await mkdir(dirname(live), { recursive: true })
        await copyFile(backup, live)
      } else {
        await rmRetry(live)
      }
    }
    return true
  } catch {
    return false
  }
}

async function tryGitRestore(git: Git, head: string): Promise<boolean> {
  const abort = await git.run(['merge', '--abort'], { allowFailure: true })
  void abort
  const reset = await git.run(['reset', '--hard', head], { allowFailure: true })
  return reset.code === 0
}

async function finish(
  store: ArtifactStore,
  input: ApplyInput,
  logPath: string,
  partial: Omit<ApplyOutcome, 'applicationId' | 'logPath'>,
): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = {
    applicationId: input.applicationId,
    logPath,
    ...partial,
  }
  await store.writeJson(join(store.applyDir(input.applicationId), 'outcome.json'), outcome)
  return outcome
}

function life(label: string, outcome: Evidence['outcome'], detail: string | null): Evidence {
  return { kind: 'lifecycle', label, outcome, detail }
}

async function log(path: string, entry: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

function summarize(stdout: string, stderr: string): string | null {
  const text = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n')
  return text.length > 0 ? text.slice(0, 4_000) : null
}
