import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { AuthError, AuthStore } from './auth.js'
import { createMcpHttpHandler } from '@lachesis/mcp'
import { LachesisApplication } from './application.js'
import { handleHttpApi } from './http.js'

export interface Config {
  dataRoot: string
  staticRoot: string
  launchId?: string
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString('utf8')
    if (body.length > 1024 * 1024) throw new AuthError('body_too_large', 413, 'Request body is too large')
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new AuthError('invalid_json', 400, 'Request body must be valid JSON')
  }
}

const mediaTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function serveWeb(staticRoot: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  let name: string
  try {
    name = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: { code: 'bad_path', message: 'Invalid path' } })
    return
  }
  if (name.includes('\0') || name.includes('\\') || name.split('/').includes('..')) {
    sendJson(res, 400, { error: { code: 'bad_path', message: 'Invalid path' } })
    return
  }
  const root = resolve(staticRoot)
  const candidate = resolve(root, `.${name}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    sendJson(res, 400, { error: { code: 'bad_path', message: 'Invalid path' } })
    return
  }
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(root, 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 503, { error: { code: 'web_not_built', message: 'The web interface has not been built yet' } })
    return
  }
  const ext = file.slice(file.lastIndexOf('.'))
  res.writeHead(200, {
    'Content-Type': mediaTypes[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

export default class LachesisServer extends Service {
  static inject = ['webServer']
  static Config = z.object({
    dataRoot: z.string().required(),
    staticRoot: z.string().required(),
    launchId: z.string(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lachesisServer')
  }

  async [Service.init](): Promise<void> {
    const app = await LachesisApplication.open(this.config.dataRoot)
    const routes: Array<() => void> = []
    let closeMcp: (() => Promise<void>) | null = null
    const cleanup = async () => {
      let failure: unknown
      for (const unregister of routes.splice(0).reverse()) {
        try { unregister() } catch (error) { failure ??= error }
      }
      const close = closeMcp
      closeMcp = null
      try { await close?.() } catch (error) { failure ??= error }
      try { await app.close() } catch (error) { failure ??= error }
      if (failure !== undefined) throw failure
    }
    try {
    const auth = new AuthStore(app.dataRoot)
    const mcp = createMcpHttpHandler({
      authenticate: (req) => auth.authenticateToken(req),
      invoke: ({ operation, input, actor, idempotencyKey }) => app.invoke(operation, input, {
        actor,
        idempotencyKey: idempotencyKey ?? null,
      }),
    })
    closeMcp = () => mcp.close()
    if (auth.initialSetupCode) {
      process.stderr.write(`Lachesis first-browser setup code: ${auth.initialSetupCode}\n`)
    }
    const health = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/v1/health',
      handler: (_req, res) => sendJson(res, 200, {
        data: { ready: true, product: 'Lachesis', runtimeVersion: '0.1.7-alpha.2', launchId: this.config.launchId ?? null },
      }),
    })
    routes.push(health)
    const api = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/v1',
      handler: async (req, res) => {
        try {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname
          if (path === '/api/v1/session' && req.method === 'GET') {
            const session = auth.session(req)
            if (!session) throw new AuthError('authentication_required', 401, 'Pair this browser with Lachesis')
            sendJson(res, 200, { data: { actor: session.actor, csrfToken: session.csrf } })
            return
          }
          if (path === '/api/v1/session' && req.method === 'POST') {
            if (req.headers.origin !== `http://${req.headers.host}`) {
              throw new AuthError('invalid_origin', 403, 'Browser origin does not match this service')
            }
            const input = await readJson(req) as { code?: unknown }
            if (typeof input.code !== 'string') throw new AuthError('invalid_input', 400, 'Enter the setup code')
            const session = auth.pair(input.code)
            sendJson(res, 200, { data: { csrfToken: session.csrf } }, { 'Set-Cookie': session.cookie })
            return
          }
          if (path === '/api/v1/session/pairing-code' && req.method === 'POST') {
            const actor = auth.authenticate(req, 'session.pair')
            if (actor.kind !== 'browser') throw new AuthError('permission_denied', 403, 'Only the local operator can pair browsers')
            sendJson(res, 200, { data: { code: auth.issuePairingCode() } })
            return
          }
          if (path === '/api/v1/tokens' && req.method === 'GET') {
            const actor = auth.authenticate(req, 'token.manage')
            if (actor.kind !== 'browser') throw new AuthError('permission_denied', 403, 'Only the local operator can manage tokens')
            sendJson(res, 200, { data: { items: auth.listTokens(), nextCursor: null } })
            return
          }
          if (path === '/api/v1/tokens' && req.method === 'POST') {
            const actor = auth.authenticate(req, 'token.manage')
            if (actor.kind !== 'browser') throw new AuthError('permission_denied', 403, 'Only the local operator can manage tokens')
            const input = await readJson(req) as { projectIds?: unknown; permissions?: unknown }
            if (!Array.isArray(input.projectIds) || !input.projectIds.every((value) => typeof value === 'string') ||
              !Array.isArray(input.permissions) || !input.permissions.every((value) => typeof value === 'string')) {
              throw new AuthError('invalid_input', 400, 'Project IDs and permissions must be lists')
            }
            sendJson(res, 201, { data: auth.createToken(input.projectIds, input.permissions) })
            return
          }
          if (path.startsWith('/api/v1/tokens/') && req.method === 'DELETE') {
            const actor = auth.authenticate(req, 'token.manage')
            if (actor.kind !== 'browser') throw new AuthError('permission_denied', 403, 'Only the local operator can manage tokens')
            const id = decodeURIComponent(path.slice('/api/v1/tokens/'.length))
            const revoked = auth.revokeToken(id)
            sendJson(res, revoked ? 200 : 404, revoked
              ? { data: { revoked: true } }
              : { error: { code: 'not_found', message: 'Token not found' } })
            return
          }
          if (path === '/api/v1/admin/shutdown' && req.method === 'POST') {
            const actor = auth.authenticate(req, 'admin.shutdown')
            if (actor.kind !== 'browser') throw new AuthError('permission_denied', 403, 'Only the local operator can stop the service')
            sendJson(res, 202, { data: { stopping: true } })
            setImmediate(() => process.emit('SIGTERM'))
            return
          }
          await handleHttpApi(req, res, auth, app, (error) => {
            this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
          })
        } catch (error) {
          if (error instanceof AuthError) {
            sendJson(res, error.status, { error: { code: error.code, message: error.message } })
          } else {
            this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
            sendJson(res, 500, { error: { code: 'internal_error', message: 'The request could not be completed' } })
          }
        }
      },
    })
    routes.push(api)
    const mcpRoute = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/mcp',
      handler: (req, res) => mcp.handle(req, res),
    })
    routes.push(mcpRoute)
    const fallback = this.ctx.webServer.registerFallback((req, res) => serveWeb(this.config.staticRoot, req, res))
    routes.push(fallback)
    app.start()
    this.ctx.effect(() => cleanup, 'lachesisServer.routes')
    } catch (error) {
      try { await cleanup() }
      catch (cleanupError) {
        this.ctx.logger.error(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)))
      }
      throw error
    }
  }
}
