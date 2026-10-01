import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DataRootLease } from './instance.ts'
import { DomainService } from './service.ts'

/** Where the persistence layer keeps the Lachesis state database. */
export interface Config {
  /** Absolute data directory; the database and the lease both live under it. */
  dataRoot: string
  /** Database file. Defaults to `<dataRoot>/lachesis.sqlite`. */
  databasePath?: string
  /** SQLite busy timeout in milliseconds. */
  busyTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The persistent domain service, provided by `@lachesis/plugin-domain`. */
    'lachesis.domain': DomainService
    /** The process-lifetime claim on the data directory. */
    'lachesis.dataRoot': DataRootLease
  }
}

/** Close the database, then release the data-root claim. */
export async function closeDataRoot(domain: DomainService | null, lease: DataRootLease | null): Promise<void> {
  if (!lease || lease.isRetained) return
  try { domain?.close() } finally { await lease.release() }
}

/**
 * Owns everything that must outlive a single request: the exclusive claim on
 * the data directory and the SQLite database behind it.
 *
 * The lease is taken before the database opens, so a second service fails
 * without ever touching a live one. `DataRootLease.retain()` keeps the claim
 * held when a shutdown could not confirm that every worker process range
 * exited, so no second service can recover the database underneath it.
 */
export class LachesisDomain extends Service {
  static inject: string[] = []
  static Config: z<Config> = z.object({
    dataRoot: z.string().required(),
    databasePath: z.string(),
    busyTimeoutMs: z.number().default(5000),
  })

  private readonly config: Config
  private lease: DataRootLease | null = null
  private domain: DomainService | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lachesisDomain')
    this.config = config
  }

  async [Service.init](): Promise<void> {
    const lease = await DataRootLease.acquire(resolve(this.config.dataRoot))
    let domain: DomainService | null = null
    try {
      domain = DomainService.open({
        databasePath: this.config.databasePath
          ? (isAbsolute(this.config.databasePath) ? this.config.databasePath : resolve(this.config.databasePath))
          : join(lease.dataRoot, 'lachesis.sqlite'),
        busyTimeoutMs: this.config.busyTimeoutMs ?? 5000,
      })
    } catch (error) {
      await lease.release()
      throw error
    }
    this.lease = lease
    this.domain = domain
    this.ctx.provide('lachesis.domain', domain)
    this.ctx.provide('lachesis.dataRoot', lease)
    this.ctx.effect(() => () => closeDataRoot(this.domain, this.lease), 'lachesis.domain.close')
  }
}

export default LachesisDomain

