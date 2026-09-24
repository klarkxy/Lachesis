import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '@lachesis/domain'
import { WorkspaceError } from '@lachesis/workspace'
import { ApplicationError, type LachesisApplication } from './application.js'
import { AuthError, type AuthStore } from './auth.js'

interface Route {
  method: string
  pattern: RegExp
  operation: string
  permission: string
  created?: boolean
  idempotent?: boolean
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/v1\/scheduler$/, operation: 'scheduler.get', permission: 'scheduler.read' },
  { method: 'PUT', pattern: /^\/api\/v1\/scheduler$/, operation: 'scheduler.update', permission: 'scheduler.write' },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/(?<projectId>[^/]+)\/dispatch$/, operation: 'project.dispatch', permission: 'project.read' },
  { method: 'PATCH', pattern: /^\/api\/v1\/projects\/(?<projectId>[^/]+)\/dispatch$/, operation: 'project.pause', permission: 'project.control' },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/(?<projectId>[^/]+)\/readiness$/, operation: 'project.readiness', permission: 'project.control' },
  { method: 'PATCH', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/plan$/, operation: 'issue.plan', permission: 'issue.create' },
  { method: 'GET', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/checkpoints$/, operation: 'issue.checkpoints', permission: 'issue.read' },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/resume$/, operation: 'issue.resume', permission: 'issue.retry' },
  { method: 'POST', pattern: /^\/api\/v1\/runs\/(?<runId>[^/]+)\/checkpoint$/, operation: 'run.checkpoint', permission: 'issue.rework' },
  { method: 'GET', pattern: /^\/api\/v1\/applications\/(?<applicationId>[^/]+)\/verification$/, operation: 'application.verification', permission: 'application.read' },
  { method: 'GET', pattern: /^\/api\/v1\/projects$/, operation: 'project.list', permission: 'project.read' },
  { method: 'POST', pattern: /^\/api\/v1\/projects$/, operation: 'project.create', permission: 'project.create', created: true },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/(?<projectId>[^/]+)$/, operation: 'project.get', permission: 'project.read' },
  { method: 'GET', pattern: /^\/api\/v1\/profiles$/, operation: 'profile.list', permission: 'profile.read' },
  { method: 'POST', pattern: /^\/api\/v1\/profiles$/, operation: 'profile.create', permission: 'profile.create', created: true },
  { method: 'POST', pattern: /^\/api\/v1\/profiles\/capabilities$/, operation: 'profile.capabilities', permission: 'profile.read' },
  { method: 'GET', pattern: /^\/api\/v1\/profiles\/(?<profileId>[^/]+)$/, operation: 'profile.get', permission: 'profile.read' },
  { method: 'PATCH', pattern: /^\/api\/v1\/profiles\/(?<profileId>[^/]+)$/, operation: 'profile.update', permission: 'profile.update' },
  { method: 'GET', pattern: /^\/api\/v1\/profiles\/(?<profileId>[^/]+)\/history$/, operation: 'profile.history', permission: 'profile.read' },
  { method: 'GET', pattern: /^\/api\/v1\/issues$/, operation: 'issue.list', permission: 'issue.read' },
  { method: 'POST', pattern: /^\/api\/v1\/issues$/, operation: 'issue.create', permission: 'issue.create', created: true, idempotent: true },
  { method: 'GET', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)$/, operation: 'issue.get', permission: 'issue.read' },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/comments$/, operation: 'issue.comment', permission: 'issue.comment', created: true },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/cancel$/, operation: 'issue.cancel', permission: 'issue.cancel' },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/retry$/, operation: 'issue.retry', permission: 'issue.retry' },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/accept$/, operation: 'issue.accept', permission: 'issue.accept' },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/rework$/, operation: 'issue.rework', permission: 'issue.rework' },
  { method: 'PUT', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/evaluation$/, operation: 'issue.evaluate', permission: 'issue.evaluate', idempotent: true },
  { method: 'POST', pattern: /^\/api\/v1\/issues\/(?<issueId>[^/]+)\/integrations$/, operation: 'application.prepare', permission: 'application.prepare', created: true, idempotent: true },
  { method: 'GET', pattern: /^\/api\/v1\/runs\/(?<runId>[^/]+)$/, operation: 'run.get', permission: 'run.read' },
  { method: 'GET', pattern: /^\/api\/v1\/runs\/(?<runId>[^/]+)\/events$/, operation: 'run.events', permission: 'run.read' },
  { method: 'POST', pattern: /^\/api\/v1\/runs\/(?<runId>[^/]+)\/messages$/, operation: 'run.message', permission: 'run.message', created: true },
  { method: 'POST', pattern: /^\/api\/v1\/runs\/(?<runId>[^/]+)\/questions\/(?<questionId>[^/]+)\/answer$/, operation: 'question.answer', permission: 'question.answer' },
  { method: 'GET', pattern: /^\/api\/v1\/applications\/(?<applicationId>[^/]+)$/, operation: 'application.get', permission: 'application.read' },
  { method: 'POST', pattern: /^\/api\/v1\/applications\/(?<applicationId>[^/]+)\/apply$/, operation: 'application.apply', permission: 'application.apply', idempotent: true },
  { method: 'GET', pattern: /^\/api\/v1\/events$/, operation: 'events.list', permission: 'events.read' },
]

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString('utf8')
    if (body.length > 1024 * 1024) throw new ApplicationError('body_too_large', 413, 'Request body is too large')
  }
  if (!body) return {}
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new ApplicationError('invalid_json', 400, 'Request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApplicationError('invalid_json', 400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof AuthError || error instanceof ApplicationError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } }
  }
  if (error instanceof DomainError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 :
      ['version_conflict', 'idempotency_conflict', 'conflict', 'late_result'].includes(error.code) ? 409 : 400
    return { status, body: { error: { code: error.code, message: error.message, details: error.details } } }
  }
  if (error instanceof WorkspaceError) {
    return { status: error.code === 'not_found' ? 404 : error.code === 'invalid_path' ? 400 : 409,
      body: { error: { code: error.code, message: error.message } } }
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'The request could not be completed' } } }
}

export async function handleHttpApi(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthStore,
  app: LachesisApplication,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const fileMatch = /^\/api\/v1\/(deliveries|checkpoints)\/([^/]+)\/files\/(.+)$/.exec(pathname)
    if (req.method === 'GET' && fileMatch) {
      const actor = auth.authenticate(req, 'delivery.read')
      const deliveryId = decodeURIComponent(fileMatch[2]!)
      const path = decodeURIComponent(fileMatch[3]!)
      const file = fileMatch[1] === 'checkpoints'
        ? await app.readCheckpointFile(actor, deliveryId, path)
        : await app.readDeliveryFile(actor, deliveryId, path)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.bytes.byteLength,
        'Content-Disposition': 'attachment; filename="artifact"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(file.bytes)
      return
    }
    if (req.method === 'GET' && pathname === '/api/v1/events/stream') {
      const actor = auth.authenticate(req, 'events.read')
      const input: Record<string, unknown> = {
        projectId: url.searchParams.get('projectId') ?? undefined,
        after: url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0',
      }
      // Check project scope before committing an event stream response.
      const first = await app.invoke('events.list', input, { actor, idempotencyKey: null }) as { items: Array<{ sequence: number }>; nextCursor: string | null }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      })
      res.flushHeaders()
      res.write(': connected\n\n')
      let cursor = String(input.after)
      let polling = false
      let closed = false
      const writePage = (page: typeof first) => {
        for (const event of page.items) {
          cursor = String(event.sequence)
          res.write(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`)
        }
      }
      writePage(first)
      const timer = setInterval(async () => {
        if (polling || closed) return
        polling = true
        try {
          const page = await app.invoke('events.list', { ...input, after: cursor }, { actor, idempotencyKey: null }) as typeof first
          writePage(page)
        } catch { res.end() } finally { polling = false }
      }, 500)
      res.on('close', () => { closed = true; clearInterval(timer) })
      return
    }
    const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(pathname))
    if (!route) {
      respond(res, 404, { error: { code: 'not_found', message: 'Unknown API route' } })
      return
    }
    const actor = auth.authenticate(req, route.permission)
    const key = req.headers['idempotency-key']
    const idempotencyKey = typeof key === 'string' && key.trim() !== '' ? key : null
    if (route.idempotent && idempotencyKey === null) {
      throw new ApplicationError('idempotency_key_required', 400, 'Idempotency-Key is required')
    }
    const match = route.pattern.exec(pathname)
    const pathParams = Object.fromEntries(Object.entries(match?.groups ?? {}).map(([name, value]) => [name, decodeURIComponent(value)]))
    const queryParams = Object.fromEntries(url.searchParams)
    const input = { ...queryParams, ...await bodyOf(req), ...pathParams }
    const data = await app.invoke(route.operation, input, { actor, idempotencyKey })
    respond(res, route.created ? 201 : 200, { data })
  } catch (error) {
    const response = errorResponse(error)
    if (response.status === 500) onError(error)
    respond(res, response.status, response.body)
  }
}
