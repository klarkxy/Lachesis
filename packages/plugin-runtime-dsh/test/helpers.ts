import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshAcpExecutor, type DshAcpExecutor, type RunEvent, type RunHandle } from '../src/index.ts'

export function fixtureCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))]
}

export async function makeWorkspace(prefix: string): Promise<{ cwd: string; dshHome: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const cwd = join(root, 'work')
  const dshHome = join(root, 'dsh-home')
  await mkdir(cwd)
  await mkdir(dshHome)
  return {
    cwd,
    dshHome,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function withExecutor<T>(fn: (executor: DshAcpExecutor) => Promise<T>): Promise<T> {
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  try {
    return await fn(executor)
  } finally {
    await executor.closeAll()
  }
}

export function sinkEvents(handle: RunHandle): {
  items: RunEvent[]
  waitFor: (predicate: (event: RunEvent) => boolean, timeoutMs?: number) => Promise<RunEvent>
} {
  const items: RunEvent[] = []
  void (async () => {
    for await (const event of handle.events) items.push(event)
  })()
  return {
    items,
    waitFor: async (predicate, timeoutMs = 15_000) => {
      const start = Date.now()
      for (;;) {
        const found = items.find(predicate)
        if (found !== undefined) return found
        if (Date.now() - start > timeoutMs) {
          throw new Error(`timed out waiting for event; saw ${JSON.stringify(items.map((item) => item.type))}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}

export function assistantText(items: RunEvent[]): string {
  return items
    .filter((event) => event.type === 'acp_update' && event.update.sessionUpdate === 'agent_message_chunk')
    .map((event) => {
      if (event.type !== 'acp_update') return ''
      const update = event.update
      if (update.sessionUpdate !== 'agent_message_chunk') return ''
      return update.content.type === 'text' ? update.content.text : ''
    })
    .join('')
}
