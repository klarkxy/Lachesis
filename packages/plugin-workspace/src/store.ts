import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { sha256Bytes } from './hash.ts'
import { assertAbsolutePath, assertSafeId } from './paths.ts'

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

  async putBlob(bytes: Uint8Array): Promise<string> {
    const sha = sha256Bytes(bytes)
    const dest = this.blobPath(sha)
    await mkdir(dirname(dest), { recursive: true })
    try {
      await writeFile(dest, bytes, { flag: 'wx' })
    } catch (error) {
      if (!isExist(error)) throw error
      const existing = await readFile(dest)
      if (sha256Bytes(existing) !== sha) {
        throw new WorkspaceError('store_corrupt', `Blob ${sha} already exists with different bytes`)
      }
    }
    return sha
  }

  async getBlob(sha256: string): Promise<Uint8Array> {
    try {
      const buf = await readFile(this.blobPath(sha256))
      return buf
    } catch (error) {
      throw new WorkspaceError('not_found', `Blob ${sha256} is missing`, error)
    }
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
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST')
}
