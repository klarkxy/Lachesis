import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DshAcpExecutor, RunHandle, RunSpec } from '@lachesis/runtime'
import { openDomain } from '@lachesis/domain'
import { ApplicationError, LachesisApplication } from '../src/application.ts'
import { RunSupervisor } from '../src/supervisor.ts'

const browser = { kind: 'browser' as const, id: 'operator', projectIds: null, permissions: null }
const token = { kind: 'token' as const, id: 'client', projectIds: [], permissions: ['*'] }

function handleFor(spec: RunSpec, options: RunHandle['route'], onClose: () => void,
  rangeExited = true): RunHandle {
  return {
    runId: 'probe-run', sessionId: 'probe-session', state: 'ready', deliveryStatus: 'none',
    route: options, processFacts: undefined,
    events: (async function* () {})(),
    async send() { throw new Error(`Probe sent a prompt to ${spec.model}`) },
    async answerPermission() { throw new Error('Probe requested a permission') },
    async cancel() {},
    async close() { onClose() },
    done: Promise.resolve({ state: 'closed', deliveryStatus: 'none', exitCode: 0,
      signal: null, rangeExited }),
  }
}

test('Profile probe snapshots config, returns actual ACP reasoning options, and closes before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-profile-probe-'))
  const dataRoot = join(root, 'data')
  const patchDir = join(dataRoot, 'dsh')
  await mkdir(patchDir, { recursive: true })
  await writeFile(join(patchDir, 'cordis.patch.yml'), 'provider: test\n')
  const priorKey = process.env.OCG_GATEWAY_KEY
  process.env.OCG_GATEWAY_KEY = 'synthetic-probe-key'
  let closed = false
  let observedRoot = ''
  const runtime: DshAcpExecutor = {
    async start(spec) {
      observedRoot = join(spec.cwd, '..')
      assert.equal(await readFile(join(spec.dshHome, 'cordis.patch.yml'), 'utf8'), 'provider: test\n')
      assert.deepEqual(spec.env, { OCG_GATEWAY_KEY: 'synthetic-probe-key' })
      assert.equal(spec.permissionMode, 'reject-once')
      assert.deepEqual(await readdir(spec.cwd), [])
      return handleFor(spec, {
        provider: spec.provider, model: spec.model, modelOptionValue: JSON.stringify([spec.provider, spec.model]),
        configOptions: [{ id: 'reasoning_effort', name: 'Reasoning', type: 'select', currentValue: '',
          options: [{ value: '', name: 'Provider default' }, { group: 'Levels', name: 'Levels',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }],
      }, () => { closed = true })
    },
    async closeAll() {},
  }
  const app = await LachesisApplication.open(dataRoot, runtime)
  try {
    const response = await app.invoke('profile.capabilities', { providerRef: 'local-ocg', modelId: 'test-model' },
      { actor: browser, idempotencyKey: null })
    assert.deepEqual(response, { providerRef: 'local-ocg', modelId: 'test-model', reasoningOptions: [
      { value: '', name: 'Provider default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
    ] })
    assert.equal(closed, true)
    await assert.rejects(readFile(join(observedRoot, 'dsh-home', 'cordis.patch.yml')))
    assert.equal(await readFile(join(patchDir, 'cordis.patch.yml'), 'utf8'), 'provider: test\n')
  } finally {
    await app.close()
    if (priorKey === undefined) delete process.env.OCG_GATEWAY_KEY
    else process.env.OCG_GATEWAY_KEY = priorKey
    await rm(root, { recursive: true, force: true })
  }
})

test('Profile probe returns no options when ACP omits reasoning and denies token clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-profile-empty-'))
  let starts = 0
  const runtime: DshAcpExecutor = {
    async start(spec) {
      starts++
      return handleFor(spec, { provider: spec.provider, model: spec.model,
        modelOptionValue: JSON.stringify([spec.provider, spec.model]), configOptions: [] }, () => {})
    },
    async closeAll() {},
  }
  const app = await LachesisApplication.open(join(root, 'data'), runtime)
  try {
    await assert.rejects(app.invoke('profile.capabilities', { providerRef: 'p', modelId: 'm' },
      { actor: token, idempotencyKey: null }),
    (error) => error instanceof ApplicationError && error.code === 'permission_denied')
    assert.equal(starts, 0)
    assert.deepEqual(await app.invoke('profile.capabilities', { providerRef: 'p', modelId: 'm' },
      { actor: browser, idempotencyKey: null }), { providerRef: 'p', modelId: 'm', reasoningOptions: [] })
    await assert.rejects(app.invoke('profile.capabilities', { providerRef: '', modelId: 'm' },
      { actor: browser, idempotencyKey: null }),
    (error) => error instanceof ApplicationError && error.code === 'invalid_input')
    assert.equal(starts, 1)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Service stop waits for an in-flight probe and rejects its result after range closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-profile-stop-'))
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let closed = false
  const runtime: DshAcpExecutor = {
    async start(spec) {
      entered()
      await gate
      return handleFor(spec, { provider: spec.provider, model: spec.model,
        modelOptionValue: JSON.stringify([spec.provider, spec.model]), configOptions: [] },
      () => { closed = true })
    },
    async closeAll() {},
  }
  const app = await LachesisApplication.open(join(root, 'data'), runtime)
  try {
    const probing = app.invoke('profile.capabilities', { providerRef: 'p', modelId: 'm' },
      { actor: browser, idempotencyKey: null })
    await started
    const closing = app.close()
    release()
    await assert.rejects(probing, (error) => error instanceof ApplicationError && error.code === 'service_stopping')
    await closing
    assert.equal(closed, true)
  } finally {
    release()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unconfirmed Profile probe exit blocks another probe until service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-profile-unconfirmed-'))
  const domain = openDomain(join(root, 'lachesis.sqlite'))
  let starts = 0
  const runtime: DshAcpExecutor = {
    async start(spec) {
      starts++
      return handleFor(spec, { provider: spec.provider, model: spec.model,
        modelOptionValue: JSON.stringify([spec.provider, spec.model]), configOptions: [] },
      () => {}, starts !== 1)
    },
    async closeAll() {},
  }
  const supervisor = new RunSupervisor(domain, root, runtime)
  try {
    await assert.rejects(supervisor.probeProfileCapabilities('p', 'm'),
      (error) => error instanceof ApplicationError && error.code === 'range_unconfirmed')
    assert.throws(() => supervisor.probeProfileCapabilities('p', 'm'),
      (error) => error instanceof ApplicationError && error.code === 'range_unconfirmed')
    assert.equal(starts, 1)
    await assert.rejects(supervisor.stop(), /profile capability probe could not confirm worker range exit/i)
  } finally {
    domain.close()
    await rm(root, { recursive: true, force: true })
  }
})
