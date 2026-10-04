import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { applyCandidate } from './apply.ts'
import { readBaselineFile } from './baseline.ts'
import { WorkspaceError } from './errors.ts'
import { freezeDelivery, loadManifest, writeCheckpoint } from './freeze.ts'
import { removeConfirmed, rmRetry } from './fsx.ts'
import { Git } from './git.ts'
import { integrate } from './integrate.ts'
import type { StoragePolicy, StorageReservationBackend, StorageStatus } from './ledger.ts'
import { StorageLedger } from './ledger.ts'
import { serviceGitPath } from './objects.ts'
import { assertAbsolutePath, assertRelativePosix, assertSafeId, safeJoin } from './paths.ts'
import { loadRun, planRunReservation, prepareRun } from './prepare.ts'
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
  RunReservationEstimate,
  RunReservationQuery,
  WorkerStopProof,
  WorkspaceOptions,
} from './types.ts'
import { snapshotTree } from './snapshot.ts'
import { assertWorkerStopped } from './worker.ts'

export class Workspace {
  readonly store: ArtifactStore
  readonly gitBin: string
  /** Worker directories. Never an ancestor or descendant of the artifact store. */
  readonly executionRoot: string
  /** Measurement and admission facade. The reservation authority is the injected backend. */
  readonly ledger: StorageLedger
  private readonly targetLock: TargetLock

  constructor(options: WorkspaceOptions) {
    const storeRoot = assertAbsolutePath('storeRoot', options.storeRoot)
    this.store = new ArtifactStore(storeRoot)
    this.gitBin = options.gitBin ?? 'git'
    this.executionRoot = options.executionRoot
      ? assertAbsolutePath('executionRoot', options.executionRoot)
      : resolve(storeRoot, '..', 'execution')
    this.ledger = new StorageLedger(storeRoot, this.executionRoot, options.storagePolicy)
    this.targetLock = new TargetLock(this.gitBin)
  }

  static async create(options: WorkspaceOptions): Promise<Workspace> {
    const root = assertAbsolutePath('storeRoot', options.storeRoot)
    await mkdir(root, { recursive: true })
    return new Workspace({ ...options, storeRoot: root })
  }

  setStoragePolicy(policy: Partial<StoragePolicy>): StoragePolicy {
    return this.ledger.setPolicy(policy)
  }

  async storageStatus(): Promise<StorageStatus> {
    return this.ledger.status()
  }

  /** Domain SQLite is the production authority. Calling this replaces the memory backend. */
  configureStorageBackend(backend: StorageReservationBackend): void {
    this.ledger.useBackend(backend)
  }

  /**
   * Admission size before claim. Reads git metadata or file sizes only.
   * Does not create an execution directory and does not call a model.
   */
  async estimateRunReservation(input: RunReservationQuery): Promise<RunReservationEstimate> {
    await this.ledger.observe()
    const plan = await planRunReservation(this.store, this.host(), input)
    return { requiredBytes: plan.bytes, sourceRef: plan.sourceRef }
  }

  /** Digest of the private work view, including a rework overlay, before the worker starts. */
  async inputDigest(runId: string): Promise<string> {
    const run = await loadRun(this.store, assertSafeId('runId', runId))
    return snapshotTree(run.workspacePath)
  }

  async prepareRun(input: PrepareRunInput): Promise<PreparedWorkspace> {
    return prepareRun(this.store, this.host(), input)
  }

  async freezeDelivery(input: FreezeDeliveryInput): Promise<FrozenManifest> {
    const run = await loadRun(this.store, input.runId)
    return freezeDelivery(this.store, this.gitBin, run, input, this.ledger)
  }

  /**
   * Failure snapshot. Requires a stopped worker and a live reservation.
   * Does not delete the execution directory or release the reservation.
   */
  async saveCheckpoint(input: { runId: string; checkpointId: string; worker: WorkerStopProof }): Promise<FrozenManifest> {
    await assertWorkerStopped(input.worker)
    const run = await loadRun(this.store, input.runId)
    if (run.layout !== 'phase1') {
      throw new WorkspaceError('unsupported_kind', 'Legacy runs have no separate checkpoint publication')
    }
    return writeCheckpoint(this.store, this.gitBin, run, input.checkpointId, this.ledger)
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

  /** Bytes of one managed baseline file. Phase 1 reads the shared blob; legacy reads the directory. */
  async readBaselineBytes(runId: string, path: string): Promise<Uint8Array> {
    const run = await loadRun(this.store, assertSafeId('runId', runId))
    if (run.baselineId) return readBaselineFile(this.store, run.baselineId, path)
    if (run.baselinePath) return readFile(safeJoin(run.baselinePath, path))
    throw new WorkspaceError('not_found', `Run ${runId} has no files baseline`)
  }

  /** Bare service repository for one operator project. Delivery refs live here. */
  serviceGitDir(projectRoot: string): string {
    return serviceGitPath(this.store.root, assertAbsolutePath('projectRoot', projectRoot))
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
    if (run.layout === 'phase1') {
      await this.ledger.assertCleanupAllowed(run.runId)
      const removed = await removeConfirmed(run.executionPath ?? run.workspacePath)
      if (!removed) {
        throw new WorkspaceError('storage_unavailable', `Execution for ${runId} was not deleted; reservation retained`)
      }
      await this.ledger.releaseRun(runId)
      return
    }
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
      if (record.kind === 'git' && record.linkedWorktree !== false) {
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
    return join(this.executionRoot, assertSafeId('runId', runId), 'box', 'work')
  }

  blobPath(sha256: string): string {
    return this.store.blobPath(sha256)
  }

  /** Resolve a posix delivery path against a workspace root (path-safe). */
  resolveInside(root: string, posixPath: string): string {
    return safeJoin(root, posixPath)
  }

  private host() {
    return {
      executionRoot: this.executionRoot,
      ledger: this.ledger,
      gitBin: this.gitBin,
    }
  }
}
