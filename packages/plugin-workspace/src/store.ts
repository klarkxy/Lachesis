import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { syncDirectory } from './fsx.ts'
import { sha256Bytes } from './hash.ts'
import { assertAbsolutePath, assertSafeId } from './paths.ts'

const blobTails = new Map<string, Promise<unknown>>()

function exclusiveBlob<T>(sha: string, fn: () => Promise<T>): Promise<T> {
  const previous = blobTails.get(sha) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(() => undefined, () => undefined)
  blobTails.set(sha, settled)
  void settled.then(() => {
    if (blobTails.get(sha) === settled) blobTails.delete(sha)
  })
  return run
}

export class ArtifactStore {
  readonly root: string

  constructor(root: string) {
    this.root = assertAbsolutePath('storeRoot', root)
  }

  blobPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new WorkspaceError('store_corrupt', `Invalid blob id ${sha256}`)
    }
    return join(this.root, 'blobs', sha256.slice(0, 2), sha256.slice(2))
  }

  runDir(runId: string): string {
    return join(this.root, 'runs', assertSafeId('runId', runId))
  }

  deliveryDir(deliveryId: string): string {
    return join(this.root, 'deliveries', assertSafeId('deliveryId', deliveryId))
  }

  integrationDir(applicationId: string): string {
    return join(this.root, 'integrations', assertSafeId('applicationId', applicationId))
  }

  applyDir(applicationId: string): string {
    return join(this.root, 'apply', assertSafeId('applicationId', applicationId))
  }

  checkpointDir(checkpointId: string): string {
    return join(this.root, 'checkpoints', assertSafeId('checkpointId', checkpointId))
  }

  stagingDir(publicationId: string): string {
    return join(this.root, 'staging', assertSafeId('publicationId', publicationId))
  }

  /**
   * Publish a blob by linking a fully synced staging file onto the content path.
   * Readers of the content path never observe a partial write. One in-process lock
   * covers each hash. An existing object is kept and checked; it is not replaced.
   */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const sha = sha256Bytes(bytes)
    return exclusiveBlob(sha, async () => {
      const dest = this.blobPath(sha)
      await mkdir(dirname(dest), { recursive: true })
      const existing = await readIfPresent(dest)
      if (existing) {
        if (sha256Bytes(existing) !== sha) {
          throw new WorkspaceError('store_corrupt', `Blob ${sha} already exists with different bytes`)
        }
        return sha
      }
      const staging = join(dirname(dest), `.${sha}.${process.pid}.${randomBytes(6).toString('hex')}.partial`)
      const handle = await open(staging, 'wx')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await publishStaged(staging, dest)
        await syncDirectory(dirname(dest))
        const published = await readFile(dest)
        if (sha256Bytes(published) !== sha) {
          throw new WorkspaceError('store_corrupt', `Blob ${sha} already exists with different bytes`)
        }
        return sha
      } finally {
        await rm(staging, { force: true }).catch(() => undefined)
      }
    })
  }

  async getBlob(sha256: string): Promise<Uint8Array> {
    let buf: Buffer
    try {
      buf = await readFile(this.blobPath(sha256))
    } catch (error) {
      throw new WorkspaceError('not_found', `Blob ${sha256} is missing`, error)
    }
    if (sha256Bytes(buf) !== sha256) {
      throw new WorkspaceError('store_corrupt', `Blob ${sha256} bytes do not match its content address`)
    }
    return buf
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  async readJson<T>(path: string): Promise<T> {
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      throw new WorkspaceError('not_found', `Missing metadata ${path}`, error)
    }
  }
}

function isExist(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
  return code === 'EEXIST'
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}

/** Link is atomic and does not replace. Rename is only a same-directory fallback when the name is still absent. */
async function publishStaged(staging: string, dest: string): Promise<void> {
  try {
    await link(staging, dest)
    return
  } catch (error) {
    if (isExist(error)) return
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
    if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error
  }
  try {
    await readFile(dest)
    return
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')) throw error
  }
  try {
    await rename(staging, dest)
  } catch (error) {
    if (isExist(error)) return
    throw error
  }
}
