import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { DomainService } from '@lachesis/plugin-domain'
import type { DshAcpExecutor, RunHandle, RunSpec } from '@lachesis/plugin-runtime-dsh'
import type { LachesisHarnessDsh } from '@lachesis/plugin-runtime-dsh/plugin'
import { Workspace } from '@lachesis/plugin-workspace'
import LachesisScheduler from '../src/plugin.ts'
import { RunSupervisor } from '../src/supervisor.ts'

/** Only the two methods the scheduler's claim scan reads. */
const domain = {
  getSchedulerSettings: () => ({ globalMaxActive: 4 }),
  claimNextReadyIssue: () => null,
} as unknown as DomainService

function probeHandle(spec: RunSpec): RunHandle {
  return {
    runId: 'probe-run', sessionId: 'probe-session', state: 'ready', deliveryStatus: 'none',
    route: {
      provider: spec.provider, model: spec.model, modelOptionValue: JSON.stringify([spec.provider, spec.model]),
      configOptions: [{
        id: 'reasoning_effort', name: 'Reasoning', type: 'select', currentValue: '',
        options: [{ value: 'high', name: 'High' }],
      }],
    },
    processFacts: undefined,
    events: (async function* () {})(),
    async send() { throw new Error(`Probe sent a prompt to ${spec.model}`) },
    async answerPermission() { throw new Error('Probe requested a permission') },
    async cancel() {},
    async close() {},
    done: Promise.resolve({ state: 'closed', deliveryStatus: 'none', exitCode: 0, signal: null, rangeExited: true }),
  }
}

test('the scheduler runs on the injected workspace and the injected harness executor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-scheduler-plugin-'))
  const workspace = new Workspace({ storeRoot: join(root, 'artifacts') })
  const started: string[] = []
  const executor: DshAcpExecutor = {
    async start(spec) { started.push(spec.model); return probeHandle(spec) },
    async closeAll() {},
  }
  const ctx = new Context()
  try {
    ctx.provide('lachesis.domain', domain)
    ctx.provide('lachesis.workspace', workspace)
    ctx.provide('lachesis.harness.dsh', { executor } as LachesisHarnessDsh)
    await ctx.plugin(LachesisScheduler, { dataRoot: root })

    const scheduler = ctx.get('lachesis.scheduler')
    assert.ok(scheduler instanceof RunSupervisor, 'lachesis.scheduler must be a RunSupervisor')
    // The project target lock is held in memory, so a second Workspace over the
    // same store root would silently stop excluding this one.
    assert.equal(scheduler.workspace, workspace, 'the scheduler must run on the injected workspace')

    const options = await scheduler.probeProfileCapabilities('p', 'm')
    assert.deepEqual(options.reasoningOptions, [{ value: 'high', name: 'High' }])
    assert.deepEqual(started, ['m'], 'the scheduler must drive the injected harness executor')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('the scheduler stays pending until every injected service is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-scheduler-pending-'))
  const ctx = new Context()
  try {
    ctx.provide('lachesis.domain', domain)
    ctx.provide('lachesis.harness.dsh', {
      executor: { async start() { throw new Error('unused') }, async closeAll() {} },
    } as LachesisHarnessDsh)
    const loading = ctx.plugin(LachesisScheduler, { dataRoot: root })
    await new Promise((done) => setTimeout(done, 50))
    // Claiming Issues before the workspace exists would bypass the target lock.
    assert.equal(ctx.get('lachesis.scheduler'), undefined, 'no scheduler without lachesis.workspace')

    ctx.provide('lachesis.workspace', new Workspace({ storeRoot: join(root, 'artifacts') }))
    await loading
    assert.ok(ctx.get('lachesis.scheduler') instanceof RunSupervisor)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
