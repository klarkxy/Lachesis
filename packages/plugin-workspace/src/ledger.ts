import { lstat, readdir, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  StorageObservation,
  StoragePolicy,
  StorageReservation,
  StorageReservationBackend,
  StorageStatus,
} from '@lachesis/contracts'
import { WorkspaceError } from './errors.ts'
import { isInside } from './paths.ts'

export type { StorageObservation, StoragePolicy, StorageReservation, StorageReservationBackend, StorageStatus }

/**
 * Allocation estimate, not an exact physical-byte claim.
 * `stat.blocks` is used when the platform reports a positive 512-byte block count.
 * Otherwise the file or directory size is rounded up to the volume cluster (or 4096).
 * Measurements use `lstat` only. File contents are never read.
 * ENOENT during a walk is a cleanup race and is skipped. Every other read error fails closed.
 */
const FALLBACK_CLUSTER = 4096

const DEFAULT_POLICY: StoragePolicy = {
  maxManagedBytes: null,
  minFreeBytes: 0,
  defaultRunReserveBytes: 0,
  artifactPublishReserveBytes: 0,
  maxCacheBytes: 0,
  executionRetentionHours: 0,
  checkpointRetentionDays: null,
}

const tails = new Map<string, Promise<unknown>>()

function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(() => undefined, () => undefined)
  tails.set(key, settled)
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key)
  })
  return run
}

function asBytes(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
    if (value < 0n) return -1
    return Number(value)
  }
  return value
}

function saturate(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  return Math.floor(value)
}

export function normalizePolicy(input?: Partial<StoragePolicy> | null): StoragePolicy {
  const policy: StoragePolicy = {
    maxManagedBytes: input?.maxManagedBytes === undefined ? DEFAULT_POLICY.maxManagedBytes : input.maxManagedBytes,
    minFreeBytes: input?.minFreeBytes ?? DEFAULT_POLICY.minFreeBytes,
    defaultRunReserveBytes: input?.defaultRunReserveBytes ?? DEFAULT_POLICY.defaultRunReserveBytes,
    artifactPublishReserveBytes: input?.artifactPublishReserveBytes ?? DEFAULT_POLICY.artifactPublishReserveBytes,
    maxCacheBytes: input?.maxCacheBytes ?? DEFAULT_POLICY.maxCacheBytes,
    executionRetentionHours: input?.executionRetentionHours ?? DEFAULT_POLICY.executionRetentionHours,
    checkpointRetentionDays: input?.checkpointRetentionDays === undefined
      ? DEFAULT_POLICY.checkpointRetentionDays
      : input.checkpointRetentionDays,
  }
  assertPolicy(policy)
  return policy
}

function assertPolicy(policy: StoragePolicy): void {
  const finite = [
    ['minFreeBytes', policy.minFreeBytes],
    ['defaultRunReserveBytes', policy.defaultRunReserveBytes],
    ['artifactPublishReserveBytes', policy.artifactPublishReserveBytes],
    ['maxCacheBytes', policy.maxCacheBytes],
    ['executionRetentionHours', policy.executionRetentionHours],
  ] as const
  for (const [label, value] of finite) {
    if (!Number.isInteger(value) || value < 0) {
      throw new WorkspaceError('disk_capacity', `${label} must be a non-negative integer`)
    }
  }
  if (policy.maxManagedBytes !== null && (!Number.isInteger(policy.maxManagedBytes) || policy.maxManagedBytes < 0)) {
    throw new WorkspaceError('disk_capacity', 'maxManagedBytes must be null or a non-negative integer')
  }
  if (policy.checkpointRetentionDays !== null
    && (!Number.isInteger(policy.checkpointRetentionDays) || policy.checkpointRetentionDays < 0)) {
    throw new WorkspaceError('disk_capacity', 'checkpointRetentionDays must be null or a non-negative integer')
  }
}

/**
 * Reservation still charged to admission.
 * Materialized execution is already in `managedBytes` and in volume free space,
 * so only unused future room counts. Artifact-ready rows stay until an explicit
 * release but no longer reserve future growth.
 */
export function futureReservationBytes(row: StorageReservation, currentRunBytes: number): number {
  if (row.artifactReady) return 0
  const present = Number.isFinite(currentRunBytes) && currentRunBytes > 0 ? currentRunBytes : 0
  const growth = Math.max(0, present - Math.max(0, row.executionBaseBytes))
  return Math.max(0, row.remainingBytes - growth)
}

function allocatedFromStat(blocks: number | undefined, size: number, cluster: number): number {
  if (typeof blocks === 'number' && Number.isFinite(blocks) && blocks > 0) {
    return saturate(blocks * 512)
  }
  const basis = size > 0 ? size : cluster
  return saturate(Math.ceil(basis / cluster) * cluster)
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function measurementFailed(path: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  return new WorkspaceError('storage_unavailable', `Storage measurement failed for ${path}`, error)
}

async function volumeFacts(path: string): Promise<{ freeBytes: number; cluster: number }> {
  let space
  try {
    space = await statfs(path)
  } catch (error) {
    throw measurementFailed(path, error)
  }
  const avail = asBytes(space.bavail)
  const block = asBytes(space.bsize)
  if (avail < 0 || block <= 0) throw new WorkspaceError('storage_unavailable', 'Volume free space is unavailable')
  const freeBytes = avail >= Number.MAX_SAFE_INTEGER / block ? Number.MAX_SAFE_INTEGER : avail * block
  const cluster = block > 0 && block <= 1024 * 1024 ? block : FALLBACK_CLUSTER
  return { freeBytes, cluster }
}

async function existingAncestor(path: string): Promise<string> {
  let current = resolve(path)
  for (;;) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw measurementFailed(current, error)
      const parent = dirname(current)
      if (parent === current) throw new WorkspaceError('storage_unavailable', `Storage path does not exist: ${path}`)
      current = parent
    }
  }
}

/**
 * Reject a store and an execution root that resolve to different drive letters or
 * different UNC shares. Windows often reports `stat.dev` as 0 for every drive, so
 * the device check alone does not see that split. A matching drive or UNC root
 * does not prove the paths share a volume: a junction can still leave it.
 */
export function assertSameDriveOrUnc(storePath: string, executionPath: string): void {
  const storeRoot = driveOrUncRoot(storePath)
  const executionRoot = driveOrUncRoot(executionPath)
  if (storeRoot && executionRoot && storeRoot !== executionRoot) {
    throw new WorkspaceError(
      'storage_unavailable',
      'Unsupported cross-volume storage: the artifact store and execution root resolve to different drive or UNC roots',
    )
  }
}

function driveOrUncRoot(path: string): string | null {
  const resolved = resolve(path)
  const unc = /^[\\/][\\/]([^\\/]+)[\\/]([^\\/]+)/.exec(resolved)
  const server = unc?.[1]
  const share = unc?.[2]
  if (server && share) return `//${server.toLowerCase()}/${share.toLowerCase()}`
  const drive = /^([A-Za-z]):/.exec(resolved)
  const letter = drive?.[1]
  if (letter) return `${letter.toLowerCase()}:`
  return null
}

/** Same-volume is the supported layout. A split store and execution root is rejected. */
export function assertSameDevice(storeDev: number, executionDev: number): void {
  if (storeDev !== executionDev) {
    throw new WorkspaceError(
      'storage_unavailable',
      'Unsupported cross-volume storage: the artifact store and execution root must be on the same volume',
    )
  }
}

/** Cluster-rounded size used for admission estimates. Not an exact physical measurement. */
export function estimateAllocatedBytes(size: number, cluster: number): number {
  if (!Number.isInteger(cluster) || cluster <= 0) {
    throw new WorkspaceError('storage_unavailable', 'Volume cluster is unavailable')
  }
  const logical = Number.isFinite(size) && size > 0 ? size : 0
  return allocatedFromStat(undefined, logical, cluster)
}

export async function measurementCluster(path: string): Promise<number> {
  return (await volumeFacts(path)).cluster
}

interface WalkResult {
  total: number
  /** Bytes of each immediate child directory, including that directory itself. */
  children: Record<string, number>
}

async function walkAllocated(root: string, cluster: number): Promise<WalkResult> {
  const children: Record<string, number> = {}
  let total = 0
  let rootInfo
  try {
    rootInfo = await lstat(root)
  } catch (error) {
    if (errno(error) === 'ENOENT') return { total: 0, children }
    throw measurementFailed(root, error)
  }
  if (rootInfo.isSymbolicLink()) {
    throw new WorkspaceError('storage_unavailable', `Storage measurement refuses a symbolic link at ${root}`)
  }
  if (!rootInfo.isDirectory()) {
    throw new WorkspaceError('storage_unavailable', `Storage measurement expected a directory: ${root}`)
  }
  total = allocatedFromStat(rootInfo.blocks, rootInfo.size, cluster)
  const stack: { dir: string; rel: string }[] = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      if (errno(error) === 'ENOENT') continue
      throw measurementFailed(current.dir, error)
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      const path = join(current.dir, entry.name)
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (errno(error) === 'ENOENT') continue
        throw measurementFailed(path, error)
      }
      if (info.isSymbolicLink()) {
        throw new WorkspaceError('storage_unavailable', `Storage measurement refuses a symbolic link at ${path}`)
      }
      if (!info.isDirectory() && !info.isFile()) {
        throw new WorkspaceError('storage_unavailable', `Storage measurement refuses an unsupported entry at ${path}`)
      }
      const bytes = allocatedFromStat(info.blocks, info.size, cluster)
      total = saturate(total + bytes)
      const runId = rel.split('/')[0]
      if (runId) children[runId] = saturate((children[runId] ?? 0) + bytes)
      if (info.isDirectory()) stack.push({ dir: path, rel })
    }
  }
  return { total, children }
}

/** In-process reservation authority for standalone workspace tests. Production injects the domain backend. */
export class MemoryReservationBackend implements StorageReservationBackend {
  private readonly rows = new Map<string, StorageReservation>()

  list(): StorageReservation[] {
    return [...this.rows.values()].map((row) => ({ ...row }))
  }

  acquire(runId: string, bytes: number, observation: StorageObservation): StorageReservation {
    if (!observation || typeof observation.observedAt !== 'string' || !Number.isFinite(observation.managedBytes)) {
      throw new WorkspaceError('storage_unavailable', 'Reservation acquire requires a storage observation')
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new WorkspaceError('disk_capacity', 'Reservation size is invalid')
    }
    const existing = this.rows.get(runId)
    if (existing && bytes <= existing.bytes) return { ...existing }
    if (existing) {
      const delta = bytes - existing.bytes
      const next: StorageReservation = {
        ...existing,
        generation: existing.generation + 1,
        bytes,
        remainingBytes: saturate(existing.remainingBytes + delta),
      }
      this.rows.set(runId, next)
      return { ...next }
    }
    const created: StorageReservation = {
      runId,
      generation: 1,
      bytes,
      remainingBytes: bytes,
      executionBaseBytes: 0,
      createdAt: new Date().toISOString(),
      artifactReady: false,
      published: false,
    }
    this.rows.set(runId, created)
    return { ...created }
  }

  materialized(runId: string, remainingBytes: number, executionBaseBytes: number): void {
    const row = this.rows.get(runId)
    if (!row) throw new WorkspaceError('storage_unavailable', `Run ${runId} has no reservation to materialize`)
    if (!Number.isInteger(remainingBytes) || remainingBytes < 0 || !Number.isInteger(executionBaseBytes) || executionBaseBytes < 0) {
      throw new WorkspaceError('disk_capacity', 'Materialized reservation size is invalid')
    }
    this.rows.set(runId, { ...row, remainingBytes, executionBaseBytes })
  }

  artifactReady(runId: string): void {
    const row = this.rows.get(runId)
    if (!row) throw new WorkspaceError('storage_unavailable', `Run ${runId} has no reservation to mark artifact-ready`)
    this.rows.set(runId, { ...row, artifactReady: true })
  }

  /**
   * Standalone dispose is the caller's confirmation. This only checks that the
   * row exists. The domain backend rejects an unconfirmed worker or an
   * uncommitted completed delivery before this returns.
   */
  assertCleanupAllowed(runId: string): void {
    if (!this.rows.has(runId)) {
      throw new WorkspaceError('storage_unavailable', `Run ${runId} has no reservation to clean`)
    }
  }

  release(runId: string): void {
    this.rows.delete(runId)
  }
}

export class StorageLedger {
  readonly root: string
  readonly executionRoot: string
  private policy: StoragePolicy
  private backend: StorageReservationBackend
  private managedRoot: string | null = null

  constructor(root: string, executionRoot: string, policy?: Partial<StoragePolicy> | null, backend?: StorageReservationBackend) {
    this.root = root
    this.executionRoot = executionRoot
    this.policy = normalizePolicy(policy)
    this.backend = backend ?? new MemoryReservationBackend()
  }

  /** Production passes the domain SQLite adapter. Standalone use keeps the memory backend. */
  useBackend(backend: StorageReservationBackend): void {
    this.backend = backend
  }

  setPolicy(policy: Partial<StoragePolicy>): StoragePolicy {
    this.policy = normalizePolicy({ ...this.policy, ...policy })
    return this.policy
  }

  currentPolicy(): StoragePolicy {
    return { ...this.policy }
  }

  /** Production includes its database, logs, probe state and provider snapshots. */
  setManagedRoot(root: string): void {
    const path = resolve(root)
    if (!isInside(path, this.root) || !isInside(path, this.executionRoot)) {
      throw new WorkspaceError('storage_unavailable', 'Phase 1 managed root must contain artifact and execution directories')
    }
    this.managedRoot = path
  }

  /**
   * Metadata-only observation of every artifact directory and every execution directory.
   * `freeBytes` is the raw volume free space. Callers subtract {@link futureReservationBytes} only.
   */
  async observe(): Promise<StorageObservation> {
    if (isInside(this.root, this.executionRoot) || isInside(this.executionRoot, this.root)) {
      throw new WorkspaceError('storage_unavailable', 'Execution root and the artifact store must be separate directories on the same volume')
    }
    const [storePath, executionPath] = await Promise.all([
      existingAncestor(this.root),
      existingAncestor(this.executionRoot),
    ])
    const [storeStat, executionStat] = await Promise.all([stat(storePath), stat(executionPath)])
    assertSameDriveOrUnc(storePath, executionPath)
    assertSameDevice(storeStat.dev, executionStat.dev)
    const volume = await volumeFacts(storePath)
    const artifacts = await walkAllocated(this.root, volume.cluster)
    const execution = await walkAllocated(this.executionRoot, volume.cluster)
    const managed = this.managedRoot ? await walkAllocated(this.managedRoot, volume.cluster) : null
    return {
      managedBytes: managed ? managed.total : saturate(artifacts.total + execution.total),
      freeBytes: volume.freeBytes,
      runBytes: execution.children,
      observedAt: new Date().toISOString(),
    }
  }

  /** Allocated size of one directory, using the same estimate as {@link observe}. */
  async measureDirectory(path: string): Promise<number> {
    const anchor = await existingAncestor(path)
    const volume = await volumeFacts(anchor)
    const walked = await walkAllocated(path, volume.cluster)
    return walked.total
  }

  async status(): Promise<StorageStatus> {
    const policy = this.currentPolicy()
    try {
      const observation = await this.observe()
      const rows = this.readRows()
      const probe = policy.defaultRunReserveBytes + policy.artifactPublishReserveBytes
      return this.decide(policy, observation, rows, null, probe)
    } catch (error) {
      return unavailable(policy, error)
    }
  }

  /**
   * Hold `bytes` for `runId`. An existing row with `bytes` already at least this
   * large is reused. A larger request is an atomic top-up of the difference.
   * Admission adds managed bytes plus unused future room, not the original reservation again.
   */
  async reserve(runId: string, bytes: number): Promise<StorageReservation> {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new WorkspaceError('disk_capacity', 'Reservation size is invalid')
    }
    return exclusive(this.root, async () => {
      const observation = await this.observe()
      const rows = this.readRows()
      const gate = this.decide(this.currentPolicy(), observation, rows, runId, bytes)
      if (!gate.canDispatch) {
        throw new WorkspaceError(
          gate.diagnostic?.startsWith('storage_unavailable') ? 'storage_unavailable' : 'disk_capacity',
          gate.diagnostic ?? 'disk_capacity',
        )
      }
      try {
        return this.backend.acquire(runId, bytes, observation)
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        if (errorCode(error) === 'disk_capacity') throw error
        throw new WorkspaceError('storage_unavailable', 'Reservation authority rejected the acquire', error)
      }
    })
  }

  async materialized(runId: string, remainingBytes: number, executionBaseBytes: number): Promise<void> {
    await exclusive(this.root, async () => {
      try {
        this.backend.materialized(runId, remainingBytes, executionBaseBytes)
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceError('storage_unavailable', 'Reservation authority rejected materialize', error)
      }
    })
  }

  /** Artifact durable and worker finished. Keeps the row. Does not mean the domain delivery committed. */
  async markPublished(runId: string): Promise<void> {
    await exclusive(this.root, async () => {
      try {
        this.backend.artifactReady(runId)
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceError('storage_unavailable', 'Reservation authority rejected artifact-ready', error)
      }
    })
  }

  /** Domain checks worker exit and publication. Call this before deleting execution bytes. */
  async assertCleanupAllowed(runId: string): Promise<void> {
    await exclusive(this.root, async () => {
      const backend = this.backend as StorageReservationBackend & {
        assertCleanupAllowed?: (runId: string) => void
      }
      const check = backend.assertCleanupAllowed
      if (typeof check !== 'function') {
        throw new WorkspaceError('storage_unavailable', 'Reservation authority cannot authorize cleanup')
      }
      check.call(backend, runId)
    })
  }

  async releaseRun(runId: string): Promise<void> {
    await exclusive(this.root, async () => {
      try {
        this.backend.release(runId)
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceError('storage_unavailable', 'Reservation authority rejected release', error)
      }
    })
  }

  async listReservations(): Promise<StorageReservation[]> {
    return exclusive(this.root, async () => this.readRows())
  }

  /** Re-check admission against bytes already in use and unused future room. */
  async assertHeld(): Promise<void> {
    await exclusive(this.root, async () => {
      const observation = await this.observe()
      const gate = this.decide(this.currentPolicy(), observation, this.readRows(), null, 0)
      if (!gate.canDispatch) {
        throw new WorkspaceError(
          gate.diagnostic?.startsWith('storage_unavailable') ? 'storage_unavailable' : 'disk_capacity',
          gate.diagnostic ?? 'disk_capacity',
        )
      }
    })
  }

  private readRows(): StorageReservation[] {
    try {
      return this.backend.list()
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError('storage_unavailable', 'Reservation authority is unreadable', error)
    }
  }

  private decide(
    policy: StoragePolicy,
    observation: StorageObservation,
    rows: readonly StorageReservation[],
    runId: string | null,
    extraBytes: number,
  ): StorageStatus {
    let reservedBytes = 0
    let heldBytes = 0
    let found = false
    for (const row of rows) {
      reservedBytes = saturate(reservedBytes + futureReservationBytes(row, observation.runBytes[row.runId] ?? 0))
      if (runId !== null && row.runId === runId) {
        found = true
        heldBytes = row.bytes
      }
    }
    const delta = found ? Math.max(0, extraBytes - heldBytes) : extraBytes
    const projected = saturate(observation.managedBytes + reservedBytes + delta)
    const freeAfter = observation.freeBytes - reservedBytes - delta
    let canDispatch = true
    let diagnostic: string | null = null
    if (policy.maxManagedBytes !== null && projected > policy.maxManagedBytes) {
      canDispatch = false
      diagnostic = 'disk_capacity: managed budget exceeded'
    } else if (freeAfter < policy.minFreeBytes) {
      canDispatch = false
      diagnostic = 'disk_capacity: volume free space is below minFreeBytes'
    }
    return {
      policy,
      managedBytes: observation.managedBytes,
      freeBytes: observation.freeBytes,
      reservedBytes,
      activeReservations: rows.length,
      canDispatch,
      diagnostic,
    }
  }
}

function unavailable(policy: StoragePolicy, error: unknown): StorageStatus {
  const diagnostic = error instanceof WorkspaceError
    ? `${error.code}: ${error.message}`
    : `storage_unavailable: ${error instanceof Error ? error.message : String(error)}`
  return {
    policy,
    managedBytes: 0,
    freeBytes: 0,
    reservedBytes: 0,
    activeReservations: 0,
    canDispatch: false,
    diagnostic,
  }
}
