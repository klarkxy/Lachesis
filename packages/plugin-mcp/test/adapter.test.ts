import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHttpHandler, type McpInvocation } from '../src/index.js'

const calls: McpInvocation[] = []
const adapter = createMcpHttpHandler({
  authenticate(req) {
    const token = req.headers.authorization
    if (token !== 'Bearer alice-secret' && token !== 'Bearer bob-secret') {
      throw Object.assign(new Error('secret must stay private'), { code: 'authentication_required', status: 401 })
    }
    return { kind: 'token', id: token === 'Bearer alice-secret' ? 'alice' : 'bob', projectIds: ['project-1'], permissions: ['issue.read', 'issue.write'] }
  },
  async invoke(call) {
    calls.push(call)
    if (call.operation === 'events.wait') return new Promise(() => undefined)
    if (call.operation === 'issue.get' && call.input.issueId === 'forbidden') {
      throw Object.assign(new Error('bob-secret must stay private'), { code: 'project_denied' })
    }
    return { operation: call.operation, input: call.input, actorId: call.actor.id, id: call.operation === 'issue.create' ? 'issue-1' : undefined }
  },
})

let server: Server
let url: URL
before(async () => {
  server = createServer((req, res) => void adapter.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  url = new URL(`http://127.0.0.1:${address.port}/mcp`)
})
after(async () => {
  await adapter.close()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

async function clientFor(token: string): Promise<Client> {
  const client = new Client({ name: 'lachesis-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } }))
  return client
}

function resultData(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const first = result.content[0]
  assert.equal(first?.type, 'text')
  return JSON.parse(first.text) as Record<string, unknown>
}

test('official MCP client discovers all contracted tools and forwards isolated actors', async () => {
  const [alice, bob] = await Promise.all([clientFor('alice-secret'), clientFor('bob-secret')])
  try {
    const listed = await alice.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'application.apply', 'application.get', 'application.prepare', 'application.verification', 'events.wait',
      'issue.accept', 'issue.cancel', 'issue.comment', 'issue.create', 'issue.evaluate',
      'issue.get', 'issue.list', 'issue.rework', 'profile.get', 'profile.list',
      'project.list', 'question.answer', 'run.events', 'run.get',
      'issue.checkpoints', 'issue.plan', 'issue.resume', 'issue.retry', 'project.dispatch',
      'project.pause', 'project.readiness', 'run.checkpoint', 'scheduler.get',
    ].sort())
    const [a, b] = await Promise.all([
      alice.callTool({ name: 'issue.get', arguments: { issueId: 'issue-1' } }),
      bob.callTool({ name: 'issue.get', arguments: { issueId: 'issue-2' } }),
    ])
    assert.equal((resultData(a).data as { actorId: string }).actorId, 'alice')
    assert.equal((resultData(b).data as { actorId: string }).actorId, 'bob')
    assert.deepEqual(calls.slice(-2).map((call) => call.actor.id).sort(), ['alice', 'bob'])
  } finally {
    await Promise.all([alice.close(), bob.close()])
  }
})

test('issue creation returns the stored ID and passes idempotency separately', async () => {
  const client = await clientFor('alice-secret')
  try {
    const result = await client.callTool({ name: 'issue.create', arguments: {
      projectId: 'project-1', title: 'Test', description: 'Do the work', acceptanceCriteria: ['Done'],
      dispatch: { mode: 'auto', profileId: null }, requesterRef: 'external', idempotencyKey: 'create-1',
    } })
    assert.equal((resultData(result).data as { id: string }).id, 'issue-1')
    const call = calls.at(-1)
    assert.equal(call?.operation, 'issue.create')
    assert.equal(call?.idempotencyKey, 'create-1')
    assert.equal('idempotencyKey' in (call?.input ?? {}), false)
  } finally {
    await client.close()
  }
})

test('Zod rejects malformed writes before business invocation', async () => {
  const client = await clientFor('alice-secret')
  try {
    const count = calls.length
    const result = await client.callTool({ name: 'issue.evaluate', arguments: {
      issueId: 'issue-1', runId: 'run-1', score: 6, comment: '', expectedIssueVersion: 1,
      idempotencyKey: 'evaluate-1',
    } })
    assert.equal(result.isError, true)
    assert.equal(calls.length, count)
  } finally {
    await client.close()
  }
})

test('unauthorized requests and business errors do not reveal bearer tokens', async () => {
  const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 401)
  assert.doesNotMatch(await denied.text(), /secret/)
  const client = await clientFor('bob-secret')
  try {
    const result = await client.callTool({ name: 'issue.get', arguments: { issueId: 'forbidden' } })
    assert.equal(result.isError, true)
    const output = JSON.stringify(result)
    assert.match(output, /project_denied/)
    assert.doesNotMatch(output, /bob-secret/)
  } finally {
    await client.close()
  }
})

test('events.wait is capped by the requested deadline and aborts business work', async () => {
  const client = await clientFor('alice-secret')
  try {
    const started = Date.now()
    const result = await client.callTool({ name: 'events.wait', arguments: { projectId: 'project-1', after: '42', timeoutMs: 20 } })
    const data = resultData(result).data as { items: unknown[]; nextCursor: string; timedOut: boolean }
    assert.deepEqual(data, { items: [], nextCursor: '42', timedOut: true })
    assert.ok(Date.now() - started < 2_000)
    assert.equal(calls.at(-1)?.signal.aborted, true)
  } finally {
    await client.close()
  }
})
