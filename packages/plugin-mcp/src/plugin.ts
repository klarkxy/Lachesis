import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createMcpHttpHandler, type McpActor, type McpHttpHandler } from './adapter.js'

/** Where the MCP endpoint is mounted. */
export interface Config {
  /** URL path the MCP handler answers. */
  path?: string
}

/**
 * The operation surface MCP tools dispatch through. The HTTP service provides
 * it so this package owns no authorization or use-case logic: the MCP adapter
 * is a second encoding of the same operations the browser UI calls.
 */
export interface McpOperations {
  /** Verify the bearer credential on a request; rejects with a 401/403 status. */
  authenticateToken(req: IncomingMessage): McpActor | Promise<McpActor>
  /** Run one operation as the verified actor. */
  invoke(operation: string, input: Record<string, unknown>, context: {
    actor: McpActor
    idempotencyKey: string | null
  }): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted MCP handler. */
    'lachesis.mcp': McpHttpHandler
    /** The operation surface MCP tools dispatch through. */
    'lachesis.operations': McpOperations
  }
}

/**
 * Mounts the Model Context Protocol endpoint on the host web server.
 *
 * The plugin declares `lachesis.operations` as a dependency rather than
 * importing the HTTP service, so the MCP encoding stays a peer of the browser
 * API instead of a second copy of the authorization rules.
 */
export class LachesisMcp extends Service {
  static inject: string[] = ['webServer', 'lachesis.operations']
  static Config: z<Config> = z.object({
    path: z.string().default('/mcp'),
  })

  private readonly config: Config
  private readonly handler: McpHttpHandler
  private unregister: (() => void) | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lachesisMcp')
    this.config = config
    const operations = ctx.get('lachesis.operations')
    if (!operations) throw new Error('lachesis.operations is unavailable')
    this.handler = createMcpHttpHandler({
      authenticate: (req) => operations.authenticateToken(req),
      invoke: ({ operation, input, actor, idempotencyKey }) => operations.invoke(operation, input, {
        actor,
        idempotencyKey: idempotencyKey ?? null,
      }),
    })
    this.ctx.provide('lachesis.mcp', this.handler)
  }

  [Service.init](): void {
    const path = this.config.path ?? '/mcp'
    this.unregister = this.ctx.webServer.register({
      kind: 'prefix',
      path,
      handler: (req: IncomingMessage, res: ServerResponse) => this.handler.handle(req, res),
    })
    this.ctx.effect(() => async () => {
      this.unregister?.()
      this.unregister = null
      await this.handler.close()
    }, 'lachesis.mcp.close')
  }
}

export default LachesisMcp
