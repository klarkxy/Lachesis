import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { applyCandidate } from './apply.ts'
import { WorkspaceError } from './errors.ts'
import { freezeDelivery, loadManifest } from './freeze.ts'
import { rmRetry } from './fsx.ts'
import { Git } from './git.ts'
import { integrate } from './integrate.ts'
import { assertAbsolutePath, assertRelativePosix, assertSafeId, safeJoin } from './paths.ts'
import { loadRun, prepareRun } from './prepare.ts'
import { ArtifactStore } from './store.ts'
import { TargetLock } from './target-lock.ts'
import type { VerificationReport } from '@lachesis/contracts'
import type {
  ApplyInput,
  ApplyOutcome,
  DeliveryFileBytes,
  FreezeDeliveryInput,
  FrozenManifest,
  IntegrateInput,
  IntegrationOutcome,
  PrepareRunInput,
  PreparedWorkspace,
  WorkspaceOptions,
} from './types.ts'

export class Workspace {
  readonly store: ArtifactStore
  readonly gitBin: string
  private readonly targetLock: TargetLock

  constructor(options: WorkspaceOptions) {
    this.store = new ArtifactStore(options.storeRoot)
    this.gitBin = options.gitBin ?? 'git'
    this.targetLock = new TargetLock(this.gitBin)
  }

  static async create(options: WorkspaceOptions): Promise<Workspace> {
    const root = assertAbsolutePath('storeRoot', options.storeRoot)
    await mkdir(root, { recursive: true })
    return new Workspace({ ...options, storeRoot: root })
  }

  async prepareRun(input: PrepareRunInput): Promise<PreparedWorkspace> {
    return prepareRun(this.store, this.gitBin, input)
  }

  async freezeDelivery(input: FreezeDeliveryInput): Promise<FrozenManifest> {
    const run = await loadRun(this.store, input.runId)
    return freezeDelivery(this.store, this.gitBin, run, input)
  }

  async readDeliveryFile(deliveryId: string, path: string): Promise<DeliveryFileBytes> {
    const manifest = await loadManifest(this.store, deliveryId)
    const posix = assertRelativePosix('path', path)
    const file = manifest.files.find((entry) => entry.path === posix)
    if (!file) throw new WorkspaceError('not_found', `Delivery ${deliveryId} has no file ${posix}`)
    if (file.kind === 'deleted' || !file.sha256) {
      throw new WorkspaceError('not_found', `File ${posix} was deleted in this delivery`)
    }
    const bytes = await this.store.getBlob(file.sha256)
    return { file, bytes }
  }

  async integrate(input: IntegrateInput): Promise<IntegrationOutcome> {
    assertSafeId('applicationId', input.applicationId)
    assertAbsolutePath('projectRoot', input.projectRoot)
    return integrate(this.store, this.gitBin, input)
  }

  async apply(input: ApplyInput): Promise<ApplyOutcome> {
    assertSafeId('applicationId', input.applicationId)
    return applyCandidate(this.store, this.gitBin, input)
  }

  targetKey(projectRoot: string): Promise<string> {
    return this.targetLock.targetKey(projectRoot)
  }

  withTargetLock<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    return this.targetLock.withTargetLock(projectRoot, work)
  }

  /** The apply report supersedes the candidate report when both exist. */
  async readVerification(applicationId: string): Promise<VerificationReport | null> {
    assertSafeId('applicationId', applicationId)
    const { readFile } = await import('node:fs/promises')
    for (const path of [join(this.store.applyDir(applicationId), 'verification.json'),
      join(this.store.integrationDir(applicationId), 'verification.json')]) {
      try { return JSON.parse(await readFile(path, 'utf8')) as VerificationReport }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return null
  }

  async disposeRun(runId: string): Promise<void> {
    const run = await loadRun(this.store, runId)
    if (run.kind === 'git') {
      const git = new Git(this.gitBin, run.projectRoot)
      await git.run(['worktree', 'remove', '--force', run.workspacePath], { allowFailure: true })
      await git.run(['worktree', 'prune'], { allowFailure: true })
    }
    await rmRetry(run.workspacePath)
  }

  /** Integration worktrees stay until the host drops the candidate. */
  async disposeIntegration(applicationId: string): Promise<void> {
    const dir = this.store.integrationDir(applicationId)
    try {
      const { loadIntegration } = await import('./integrate.ts')
      const record = await loadIntegration(this.store, applicationId)
      if (record.kind === 'git') {
        const git = new Git(this.gitBin, record.projectRoot)
        await git.run(['worktree', 'remove', '--force', record.integrationPath], { allowFailure: true })
        await git.run(['worktree', 'prune'], { allowFailure: true })
      }
    } catch {
      // still remove the store directory
    }
    await rmRetry(dir)
  }

  runWorkspacePath(runId: string): string {
    return join(this.store.runDir(runId), 'work')
  }

  blobPath(sha256: string): string {
    return this.store.blobPath(sha256)
  }

  /** Resolve a posix delivery path against a workspace root (path-safe). */
  resolveInside(root: string, posixPath: string): string {
    return safeJoin(root, posixPath)
  }
}
