import type { IncomingMessage, ServerResponse } from 'node:http'
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

/** The same verified caller identity used by the HTTP application service. */
export interface McpActor {
  kind: 'browser' | 'token'
  id: string
  projectIds: string[] | null
  permissions: string[] | null
}

export type McpTokenActor = McpActor & { kind: 'token' }

export type McpOperation =
  | 'project.list' | 'profile.list' | 'profile.get'
  | 'issue.create' | 'issue.get' | 'issue.list' | 'issue.comment'
  | 'issue.cancel' | 'issue.accept' | 'issue.rework' | 'issue.evaluate'
  | 'run.get' | 'run.events' | 'question.answer'
  | 'application.prepare' | 'application.get' | 'application.apply'
  | 'events.wait'
  | 'scheduler.get' | 'project.dispatch' | 'project.pause' | 'project.readiness'
  | 'issue.plan' | 'issue.checkpoints' | 'issue.resume' | 'run.checkpoint' | 'application.verification' | 'issue.retry'

export interface McpInvocation {
  operation: McpOperation
  input: Record<string, unknown>
  actor: McpTokenActor
  idempotencyKey?: string
  signal: AbortSignal
}

export interface McpAdapterOptions {
  /** Verify the bearer with AuthStore before any MCP request is dispatched. */
  authenticate(req: IncomingMessage): McpActor | Promise<McpActor>
  /** Invoke the shared application service; it owns action and project authorization. */
  invoke(call: McpInvocation): Promise<unknown>
}

export interface McpHttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
}

const id = z.string().min(1).max(256)
const key = z.string().min(1).max(256)
const text = z.string().min(1).max(100_000)
const issueVersion = z.number().int().nonnegative()
const cursor = z.string().max(512)
const mutation = { idempotencyKey: key }
const empty = z.object({}).strict()

const tools = [
  { name: 'scheduler.get', description: 'Read capacity and exact waiting reasons for a project.', schema: z.object({ projectId: id }).strict() },
  { name: 'project.dispatch', description: 'Read project dispatch pause, environment block and drain status.', schema: z.object({ projectId: id }).strict() },
  { name: 'project.pause', description: 'Pause or resume new claims; does not cancel existing runs.', schema: z.object({ projectId: id, paused: z.boolean(), expectedVersion: issueVersion }).strict() },
  { name: 'project.readiness', description: 'Recheck the isolated worker environment without making a model request.', schema: z.object({ projectId: id, expectedVersion: issueVersion }).strict() },
  { name: 'project.list', description: 'List projects visible to the caller.', schema: empty },
  { name: 'profile.list', description: 'List visible profiles.', schema: z.object({ projectId: id.optional() }).strict() },
  { name: 'profile.get', description: 'Get a profile.', schema: z.object({ profileId: id }).strict() },
  { name: 'issue.create', description: 'Create a work item and immediately return its stored ID; execution continues separately.', schema: z.object({
    projectId: id, title: z.string().min(1).max(500), description: text,
    acceptanceCriteria: z.array(text).max(100),
    dispatch: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('require'), profileId: id }).strict(),
      z.object({ mode: z.literal('auto'), profileId: z.null() }).strict(),
    ]),
    dependsOn: z.array(id).max(100).optional(), requesterRef: id,
    ownedPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
    readOnlyPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
    clientRequestId: id.optional(), ...mutation,
  }).strict() },
  { name: 'issue.get', description: 'Get a work item and its runs, deliveries, questions and applications.', schema: z.object({ issueId: id }).strict() },
  { name: 'issue.plan', description: 'Revise dependencies and exact path scope only before the first run.', schema: z.object({ issueId: id, expectedIssueVersion: issueVersion,
    dependsOn: z.array(id).max(100).optional(), ownedPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
    readOnlyPaths: z.array(z.string().min(1).max(4096)).max(100).optional() }).strict() },
  { name: 'issue.checkpoints', description: 'List unfinished artifacts; these are not accepted deliveries.', schema: z.object({ issueId: id }).strict() },
  { name: 'issue.resume', description: 'Explicitly resume from one immutable unfinished checkpoint in a new isolated run.', schema: z.object({ issueId: id, checkpointId: id, expectedIssueVersion: issueVersion }).strict() },
  { name: 'issue.retry', description: 'Explicitly retry a failed issue without reusing unfinished files.', schema: z.object({ issueId: id, expectedIssueVersion: issueVersion }).strict() },
  { name: 'issue.list', description: 'List work items visible to the caller.', schema: z.object({ projectId: id.optional(), status: z.enum(['queued', 'blocked', 'starting', 'running', 'needs_input', 'awaiting_review', 'accepted', 'failed', 'cancelled', 'recovery_required']).optional(), after: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: 'issue.comment', description: 'Save a follow-up instruction; delivery to a run is reported separately.', schema: z.object({ issueId: id, text, ...mutation }).strict() },
  { name: 'issue.cancel', description: 'Request cancellation of the current run.', schema: z.object({ issueId: id, expectedIssueVersion: issueVersion, ...mutation }).strict() },
  { name: 'issue.accept', description: 'Accept one frozen delivery.', schema: z.object({ issueId: id, deliveryId: id, expectedIssueVersion: issueVersion, ...mutation }).strict() },
  { name: 'issue.rework', description: 'Create a rework run from one frozen delivery.', schema: z.object({ issueId: id, deliveryId: id, instructions: text, expectedIssueVersion: issueVersion, ...mutation }).strict() },
  { name: 'issue.evaluate', description: 'Score a run or delivery from 1 to 5.', schema: z.object({ issueId: id, runId: id, deliveryId: id.optional(), score: z.number().int().min(1).max(5), comment: z.string().max(100_000), expectedIssueVersion: issueVersion, ...mutation }).strict() },
  { name: 'run.get', description: 'Get an execution run and its observed facts.', schema: z.object({ runId: id }).strict() },
  { name: 'run.checkpoint', description: 'Freeze unfinished files only after managed process exit is confirmed.', schema: z.object({ runId: id }).strict() },
  { name: 'run.events', description: 'Read durable events for one execution run.', schema: z.object({ runId: id, after: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: 'question.answer', description: 'Answer one pending native question on its exact run.', schema: z.object({ runId: id, questionId: id, answers: z.record(z.string(), z.unknown()), ...mutation }).strict() },
  { name: 'application.prepare', description: 'Prepare an integration candidate from an accepted delivery.', schema: z.object({ issueId: id, deliveryId: id, expectedIssueVersion: issueVersion, ...mutation }).strict() },
  { name: 'application.get', description: 'Get a prepared candidate and verification evidence.', schema: z.object({ applicationId: id }).strict() },
  { name: 'application.verification', description: 'Read bounded redacted verification output with exit status and truncation metadata.', schema: z.object({ applicationId: id }).strict() },
  { name: 'application.apply', description: 'Explicitly apply a prepared candidate against the expected target.', schema: z.object({ applicationId: id, expectedTarget: z.string().nullable(), ...mutation }).strict() },
  { name: 'events.wait', description: 'Wait up to 30 seconds for durable project events after a cursor.', schema: z.object({ projectId: id, after: cursor.optional(), timeoutMs: z.number().int().min(1).max(30_000).default(30_000) }).strict() },
] as const

function publicError(error: unknown): { code: string; message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'operation_failed'
  return { code, message: code === 'operation_failed' ? 'Operation failed' : code.replaceAll('_', ' ') }
}

function isActor(value: unknown): value is McpTokenActor {
  if (typeof value !== 'object' || value === null) return false
  const actor = value as Partial<McpActor>
  return actor.kind === 'token' && typeof actor.id === 'string' && actor.id.length > 0 &&
    (actor.projectIds === null || (Array.isArray(actor.projectIds) && actor.projectIds.every((item) => typeof item === 'string'))) &&
    (actor.permissions === null || (Array.isArray(actor.permissions) && actor.permissions.every((item) => typeof item === 'string')))
}

/** Mount on a loopback Node HTTP server at `/mcp`; the caller owns URL routing. */
export function createMcpHttpHandler(options: McpAdapterOptions): McpHttpHandler {
  const handler = createMcpHandler(({ authInfo }) => {
    const actor = authInfo?.extra?.actor
    if (!isActor(actor)) throw new Error('MCP caller was not authenticated')
    const server = new McpServer({ name: 'lachesis', version: '0.1.0' })
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args: unknown) => {
        const parsed = tool.schema.parse(args) as Record<string, unknown>
        const { idempotencyKey, ...input } = parsed
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const request = options.invoke({
            operation: tool.name,
            input,
            actor,
            ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
            signal: controller.signal,
          })
          const result = tool.name === 'events.wait'
            ? await Promise.race([
              request,
              new Promise<unknown>((resolve) => {
                timer = setTimeout(() => {
                  controller.abort()
                  resolve({ items: [], nextCursor: input.after ?? null, timedOut: true })
                }, Number(input.timeoutMs))
              }),
            ])
            : await request
          return { content: [{ type: 'text' as const, text: JSON.stringify({ data: result ?? null }) }] }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: publicError(error) }) }] }
        } finally {
          if (timer) clearTimeout(timer)
        }
      })
    }
    return server
  }, { responseMode: 'json' })
  const node = toNodeHandler(handler)
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()

  return {
    async handle(req, res) {
      if (!req.method || !req.url) {
        res.writeHead(400).end()
        return
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return
      try {
        const actor = await options.authenticate(req)
        if (!isActor(actor)) throw new Error('Invalid authenticated actor')
        const auth: AuthInfo = { token: '', clientId: actor.id, scopes: [], extra: { actor } }
        ;(req as IncomingMessage & { auth: AuthInfo }).auth = auth
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error &&
          (error.status === 401 || error.status === 403) ? error.status : 500
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
        })
        res.end(JSON.stringify({ error: publicError(error) }))
        return
      }
      await node(req as IncomingMessage & { method: string; url: string }, res)
    },
    close: () => handler.close(),
  }
}
