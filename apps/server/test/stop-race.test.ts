import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import type { DshAcpExecutor } from '@lachesis/runtime'
import { LachesisApplication } from '../src/application.ts'

test('shutdown during workspace preparation never starts a worker afterward', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-stop-race-'))
  const target = join(root, 'target')
  await mkdir(target)
  let starts = 0
  let closed = false
  const runtime: DshAcpExecutor = {
    async start() { starts++; throw new Error('worker started after shutdown') },
    async closeAll() { closed = true },
  }
  const app = await LachesisApplication.open(join(root, 'data'), runtime)
  const actor = { kind: 'browser' as const, id: 'operator', projectIds: null, permissions: null }
  const invoke = (operation: string, input: Record<string, unknown>, idempotencyKey: string | null = null) =>
    app.invoke(operation, input, { actor, idempotencyKey })
  let entered!: () => void
  let release!: () => void
  const prepared = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = app.supervisor.workspace.prepareRun.bind(app.supervisor.workspace)
  app.supervisor.workspace.prepareRun = async (input) => {
    entered()
    await gate
    return original(input)
  }
  try {
    const project = await invoke('project.create', { name: 'Stop race', kind: 'files', rootPath: target }) as { id: string }
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake', reasoningEffort: null }) as { id: string }
    app.start()
    await invoke('issue.create', { projectId: project.id, title: 'Queued', description: 'Wait',
      acceptanceCriteria: ['safe shutdown'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'stop-race')
    await Promise.race([prepared, new Promise((_, reject) => setTimeout(() => reject(new Error('prepareRun was not entered')), 8_000))])
    const closing = app.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, true)
    release()
    await closing
    assert.equal(starts, 0)
  } finally {
    release()
    await app.close()
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing to remove a non-temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
