import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createMcpHttpHandler } from '../src/index.ts'

test('stdio proxy forwards the SDK SSE response as JSON-RPC lines', { timeout: 15_000 }, async () => {
  const adapter = createMcpHttpHandler({
    authenticate(req) {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      return { kind: 'token', id: 'test', projectIds: ['p1'], permissions: ['project.read'] }
    },
    async invoke({ operation }) {
      assert.equal(operation, 'project.list')
      return { items: [{ id: 'p1', name: 'Project' }], nextCursor: null }
    },
  })
  const server = createServer((req, res) => void adapter.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new Client({ name: 'stdio-test', version: '1.0.0' })
  const proxy = fileURLToPath(new URL('../../../scripts/mcp-stdio.mjs', import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [proxy],
    env: { ...process.env, LACHESIS_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
      LACHESIS_MCP_TOKEN: 'test-token' },
  })
  try {
    await client.connect(transport)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    assert.ok(names.includes('scheduler.get'))
    assert.ok(names.includes('issue.resume'))
    assert.ok(names.includes('application.verification'))
    const result = await client.callTool({ name: 'project.list', arguments: {} })
    assert.notEqual(result.isError, true)
    assert.equal(result.content[0]?.type, 'text')
    assert.equal(JSON.parse(result.content[0].text).data.items[0].id, 'p1')
  } finally {
    await client.close().catch(() => {})
    await adapter.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
