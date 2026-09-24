import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { resolve } from 'node:path'

/** A process-lifetime claim on one canonical Lachesis data directory. */
export class DataRootLease {
  private closed = false

  private constructor(readonly dataRoot: string, private readonly server: Server) {}

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

  async release(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>((done, reject) => {
      this.server.close((error) => error ? reject(error) : done())
    })
  }
}
