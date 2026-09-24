/**
 * Deterministic ACP 0.1.7-alpha.2 peer for adapter tests.
 * stdout is JSON-RPC only; diagnostics go to stderr.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'

const ALLOWED_EFFORTS = new Set(['', 'off', 'low', 'medium', 'high', 'max'])
const hang = process.env.LACHESIS_FIXTURE_HANG
const forever = () => new Promise(() => {})
if (hang) {
  writeFileSync(join(process.cwd(), 'agent.pid'), String(process.pid), 'utf8')
  writeFileSync(join(process.cwd(), 'agent-parent.pid'), String(process.ppid), 'utf8')
  const descendant = spawn(process.execPath, ['-e',
    'const fs = require("node:fs"); let n = 0; setInterval(() => fs.writeFileSync("heartbeat.txt", String(++n)), 50)',
  ], {
    stdio: 'ignore', windowsHide: true,
  })
  writeFileSync(join(process.cwd(), 'child.pid'), String(descendant.pid), 'utf8')
  setInterval(() => {}, 1000)
  process.on('SIGTERM', () => {})
}

let controlPresent = false
try {
  openInheritedControlChannel()
  controlPresent = true
} catch {
  controlPresent = false
}

function modelValue(provider, model) {
  return JSON.stringify([provider, model])
}

function parseModelValue(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  if (typeof parsed[0] !== 'string' || parsed[0].length === 0) return undefined
  if (typeof parsed[1] !== 'string' || parsed[1].length === 0) return undefined
  return { provider: parsed[0], model: parsed[1] }
}

function configOptions(selection) {
  const value = modelValue(selection.provider, selection.model)
  const options = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: value,
      options: [
        {
          group: selection.provider,
          name: selection.provider,
          options: [{ value, name: selection.model }],
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: selection.reasoningEffort,
      options: [...ALLOWED_EFFORTS].map((effort) => ({
        value: effort,
        name: effort.length === 0 ? 'Provider default' : effort,
      })),
    },
  ]
  return options
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

const sessions = new Map()
const defaultSelection = {
  provider: process.env.LACHESIS_FIXTURE_PROVIDER ?? 'fixture-provider',
  model: process.env.LACHESIS_FIXTURE_MODEL ?? 'fixture-model',
  reasoningEffort: '',
}

const app = agent({ name: 'lachesis-acp-fixture' })
  .onRequest(methods.agent.initialize, () => hang === 'initialize' ? forever() : ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'lachesis-acp-fixture', version: '0.1.7-alpha.2' },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  }))
  .onRequest(methods.agent.authenticate, async () => ({}))
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (hang === 'new') return forever()
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(undefined, `cwd must be an absolute path: ${params.cwd}`)
    }
    if (params.additionalDirectories?.length) {
      throw RequestError.invalidParams(undefined, 'additionalDirectories is not supported')
    }
    const sessionId = randomUUID()
    const record = {
      sessionId,
      cwd: params.cwd,
      dshHome: process.env.DSH_HOME ?? '',
      selection: { ...defaultSelection },
      cancelled: false,
      promptAbort: new AbortController(),
    }
    sessions.set(sessionId, record)
    return { sessionId, configOptions: configOptions(record.selection) }
  })
  .onRequest(methods.agent.session.list, () => ({ sessions: [] }))
  .onRequest(methods.agent.session.resume, () => {
    throw new Error('session is not resumable')
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const record = sessions.get(params.sessionId)
    if (record === undefined) throw RequestError.invalidParams(undefined, `unknown session: ${params.sessionId}`)
    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(undefined, `${params.configId} requires a select value`)
    }
    if (params.configId === 'model') {
      const parsed = parseModelValue(params.value)
      if (parsed === undefined) {
        throw RequestError.invalidParams(undefined, `unknown model option: ${params.value}`)
      }
      record.selection = { ...record.selection, ...parsed }
    } else if (params.configId === 'reasoning_effort') {
      if (!ALLOWED_EFFORTS.has(params.value)) {
        throw RequestError.invalidParams(
          undefined,
          `unknown reasoning effort for ${record.selection.provider}/${record.selection.model}: ${params.value}`,
        )
      }
      record.selection.reasoningEffort = params.value
    } else {
      throw RequestError.invalidParams(undefined, `unknown session config option: ${params.configId}`)
    }
    return { configOptions: configOptions(record.selection) }
  })
  .onRequest(methods.agent.session.close, async ({ params }) => {
    if (hang === 'close') return forever()
    const record = sessions.get(params.sessionId)
    if (record === undefined) throw new Error(`unknown session: ${params.sessionId}`)
    record.cancelled = true
    record.promptAbort.abort()
    sessions.delete(params.sessionId)
    return {}
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    const record = sessions.get(params.sessionId)
    if (record !== undefined) {
      record.cancelled = true
      record.promptAbort.abort()
    }
  })
  .onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
    if (hang === 'prompt') return forever()
    const record = sessions.get(params.sessionId)
    if (record === undefined) throw new Error(`unknown session: ${params.sessionId}`)
    record.cancelled = false
    if (record.promptAbort.signal.aborted) {
      record.promptAbort = new AbortController()
    }
    const cancelled = () => record.cancelled || signal.aborted || record.promptAbort.signal.aborted
    const text = promptText(params.prompt)

    const emit = async (message) => {
      await client.notify(methods.client.session.update, {
        sessionId: record.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message },
        },
      })
    }

    if (text.includes('SECRET')) {
      process.stderr.write('DEEPSEEK_API_KEY=sk-test-not-a-real-secret\n')
    }

    if (text.includes('CHILD')) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      if (child.pid !== undefined) {
        writeFileSync(join(record.cwd, 'child.pid'), String(child.pid), 'utf8')
      }
      await emit(`child:${child.pid ?? 0}`)
      return { stopReason: 'end_turn' }
    }

    if (text.includes('PERMISSION')) {
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId: record.sessionId,
        toolCall: { toolCallId: 'fixture-tool-1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      await emit(`permission:${JSON.stringify(permission.outcome)}`)
      return { stopReason: cancelled() ? 'cancelled' : 'end_turn' }
    }

    if (text.includes('SLOW')) {
      await new Promise((resolve) => {
        const finish = () => {
          signal.removeEventListener('abort', finish)
          record.promptAbort.signal.removeEventListener('abort', finish)
          resolve()
        }
        signal.addEventListener('abort', finish, { once: true })
        record.promptAbort.signal.addEventListener('abort', finish, { once: true })
        if (cancelled()) finish()
      })
      return { stopReason: 'cancelled' }
    }

    const payload = {
      cwd: record.cwd,
      dshHome: record.dshHome,
      sessionId: record.sessionId,
      provider: record.selection.provider,
      model: record.selection.model,
      reasoningEffort: record.selection.reasoningEffort,
      controlPresent,
      prompt: text,
    }
    await emit(JSON.stringify(payload))
    return { stopReason: record.cancelled || signal.aborted ? 'cancelled' : 'end_turn' }
  })

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)
const connection = app.connect(stream)
connection.closed.catch(() => {}).finally(() => {
  if (!hang) process.exit(0)
})
