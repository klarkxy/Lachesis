import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RunSupervisor } from './supervisor.ts'

/** How often the scheduler looks for newly ready Issues. */
export interface Config {
  /** Absolute data directory; Run dsh homes and probes live under it. */
  dataRoot: string
  /** Claim-scan interval in milliseconds. */
  tickIntervalMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Run scheduler. */
    'lachesis.scheduler': RunSupervisor
  }
}

/**
 * Claims ready Issues and runs them through the injected harness.
 *
 * The scheduler knows nothing about dsh specifically: it receives a domain
 * service, the process-wide workspace and whichever harness executor the
 * composition provides, so replacing `lachesis.harness.dsh` with another
 * implementation needs no change here. The dsh ACP adapter lives in
 * `@lachesis/plugin-runtime-dsh` and this package never imports it.
 */
export class LachesisScheduler extends Service {
  static inject: string[] = ['lachesis.domain', 'lachesis.workspace', 'lachesis.harness.dsh']
  static Config: z<Config> = z.object({
    dataRoot: z.string().required(),
    tickIntervalMs: z.number().default(1_000),
  })

  /** The supervisor this plugin owns and exposes as `lachesis.scheduler`. */
  readonly supervisor: RunSupervisor

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lachesisScheduler')
    const domain = ctx.get('lachesis.domain')
    const workspace = ctx.get('lachesis.workspace')
    const harness = ctx.get('lachesis.harness.dsh')
    if (!domain) throw new Error('lachesis.domain is unavailable')
    if (!workspace) throw new Error('lachesis.workspace is unavailable')
    if (!harness) throw new Error('lachesis.harness.dsh is unavailable')
    this.supervisor = new RunSupervisor(
      domain,
      workspace,
      resolve(config.dataRoot),
      harness.executor,
      config.tickIntervalMs ?? 1_000,
    )
    this.ctx.provide('lachesis.scheduler', this.supervisor)
  }

  [Service.init](): void {
    this.supervisor.start()
    this.ctx.effect(() => () => this.supervisor.stop(), 'lachesis.scheduler.stop')
  }
}

export default LachesisScheduler
