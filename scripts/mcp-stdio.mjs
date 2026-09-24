#!/usr/bin/env node
import { createInterface } from 'node:readline'

const endpoint = process.env.LACHESIS_MCP_URL || 'http://127.0.0.1:47831/mcp'
const token = process.env.LACHESIS_MCP_TOKEN
if (!token) {
  process.stderr.write('LACHESIS_MCP_TOKEN is required. Create a scoped token in Lachesis Settings.\n')
  process.exitCode = 1
} else {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set()
  const forward = async (line) => {
    let request
    try { request = JSON.parse(line) } catch { return }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: line,
      })
      if (request.id === undefined) return
      const body = await response.text()
      if (response.ok && body.trim()) {
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const messages = body.split(/\r?\n\r?\n/).map((frame) => frame.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean)
          if (messages.length === 0) throw new Error('MCP stream contained no response')
          for (const message of messages) process.stdout.write(`${message}\n`)
        } else {
          process.stdout.write(`${body.trim()}\n`)
        }
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: -32000, message: response.status === 401 || response.status === 403
            ? 'Lachesis token was rejected' : `Lachesis HTTP ${response.status}` } }) + '\n')
      }
    } catch {
      if (request.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: -32000, message: 'Cannot reach the local Lachesis service' } }) + '\n')
      }
    }
  }
  for await (const line of lines) {
    const task = forward(line).finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.allSettled(pending)
}
