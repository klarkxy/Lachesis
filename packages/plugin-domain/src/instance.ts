import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { resolve } from 'node:path'

/**
 * A process-lifetime claim on one canonical Lachesis data directory.
 *
 * The lease is taken before the database is opened, so a second service can
 * never touch the files of a live one. `retain()` keeps the claim held for the
 * rest of the process: releasing it would let a second service recover the
 * database while a worker process range may still be alive.
 */
export class DataRootLease {
  readonly dataRoot: string
  private readonly server: Server
  private closed = false
  private retained = false

  private constructor(dataRoot: string, server: Server) {
    this.dataRoot = dataRoot
    this.server = server
  }

  static async acquire(dataRoot: string): Promise<DataRootLease> {
    mkdirSync(dataRoot, { recursive: true })
    const canonical = realpathSync.native(resolve(dataRoot))
    const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const digest = createHash('sha256').update(identity).digest('hex')
    // Windows named pipes and Linux abstract sockets have no persistent lock file to go stale.
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\lachesis-data-${digest}`
      : process.platform === 'linux'
        ? `\0lachesis-data-${digest}`
        : null
    if (endpoint === null) throw new Error('Lachesis data-root lease is unsupported on this platform')
    const server = createServer((socket) => socket.destroy())
    try {
      await new Promise<void>((done, reject) => {
        server.once('error', reject)
        server.listen(endpoint, () => {
          server.removeListener('error', reject)
          done()
        })
      })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
        throw new Error(`Lachesis data directory is already in use: ${canonical}`, { cause: error })
      }
      throw error
    }
    return new DataRootLease(canonical, server)
  }

  /** Whether a shutdown path decided this claim must outlive the process. */
  get isRetained(): boolean { return this.retained }

  /**
   * Keep the claim held for the rest of the process. Used when worker range
   * exit is unconfirmed: a second service must not be allowed to recover the
   * database while an orphaned worker may still be writing to it.
   */
  retain(): void { this.retained = true }

  async release(): Promise<void> {
    if (this.closed || this.retained) return
    this.closed = true
    await new Promise<void>((done, reject) => {
      this.server.close((error) => error ? reject(error) : done())
    })
  }
}
