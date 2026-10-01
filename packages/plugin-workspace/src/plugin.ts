import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Workspace } from './workspace.ts'

/** Where frozen deliveries and isolated run workspaces are kept. */
export interface Config {
  /** Absolute data directory; the artifact store defaults to `<dataRoot>/artifacts`. */
  dataRoot: string
  /** Artifact store root. Defaults to `<dataRoot>/artifacts`. */
  storeRoot?: string
  /** Git executable used for git-kind projects. */
  gitBin?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Isolated run workspaces and immutable deliveries. */
    'lachesis.workspace': Workspace
  }
}

/**
 * Exposes the single {@link Workspace} that owns artifact storage and the
 * in-process project target lock.
 *
 * One instance per process is a requirement, not an optimization: `TargetLock`
 * keeps its holder table in memory, so two instances over the same store root
 * would stop excluding each other and could integrate into one project
 * concurrently.
 */
export class LachesisWorkspace extends Service {
  static inject: string[] = []
  static Config: z<Config> = z.object({
    dataRoot: z.string().required(),
    storeRoot: z.string(),
    gitBin: z.string(),
  })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lachesisWorkspace')
    this.ctx.provide('lachesis.workspace', new Workspace({
      storeRoot: config.storeRoot ? resolve(config.storeRoot) : join(resolve(config.dataRoot), 'artifacts'),
      ...(config.gitBin ? { gitBin: config.gitBin } : {}),
    }))
  }
}

export default LachesisWorkspace
