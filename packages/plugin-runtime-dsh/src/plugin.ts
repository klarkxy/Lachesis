import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DshAcpRuntime } from './executor.ts'
import { DSH_VERSION } from './types.ts'
import type { DshAcpExecutor } from './types.ts'

/** Identifies the dsh train this harness adapter drives. */
export interface Config {
  /** Locked dsh npm version this adapter was implemented against. */
  version?: string
  /** Close every live Run on SIGINT/SIGTERM. Lachesis drains its own scheduler. */
  bindProcessExit?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The dsh ACP harness. Consumers read {@link LachesisHarnessDsh.executor}. */
    'lachesis.harness.dsh': LachesisHarnessDsh
  }
}

/**
 * Exposes the dsh ACP harness.
 *
 * The executor is built on first use so an embedder — the server, the tests,
 * the MCP stdio bridge — can substitute a controlled executor before the
 * scheduler starts a Run. `version` is recorded, not resolved: the adapter
 * spawns the dsh CLI from the launch environment, and Phase 1 ships exactly
 * one supported harness. Draining live Runs stays with the scheduler, which
 * knows which ranges it must confirm exited.
 */
export class LachesisHarnessDsh extends Service {
  static inject: string[] = []
  static Config: z<Config> = z.object({
    version: z.string().default(DSH_VERSION),
    bindProcessExit: z.boolean().default(false),
  })

  private readonly config: Config
  private built: DshAcpExecutor | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lachesisHarnessDsh')
    this.config = config
    this.ctx.provide('lachesis.harness.dsh', this)
  }

  /** The recorded dsh train version. */
  get version(): string { return this.config.version ?? DSH_VERSION }

  /** The ACP executor, created on first use. */
  get executor(): DshAcpExecutor {
    this.built ??= new DshAcpRuntime({ bindProcessExit: this.config.bindProcessExit ?? false })
    return this.built
  }

  /**
   * Replace the ACP executor before the first use. For embedders that drive
   * Runs through a controlled worker instead of a real dsh process.
   */
  override(executor: DshAcpExecutor): void {
    if (this.built) throw new Error('The dsh ACP executor is already in use')
    this.built = executor
  }
}

export default LachesisHarnessDsh
