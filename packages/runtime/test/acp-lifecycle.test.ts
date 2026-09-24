import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDshAcpExecutor } from '../src/index.ts'
import {
  assistantText,
  fixtureCommand,
  makeWorkspace,
  sinkEvents,
  withExecutor,
} from './helpers.ts'

test('start verifies provider/model/effort, streams ACP text, followup, close, range exit', { timeout: 30_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-acp-')
  t.after(workspace.cleanup)
  await withExecutor(async (executor) => {
    const handle = await executor.start({
      cwd: workspace.cwd,
      dshHome: workspace.dshHome,
      provider: 'mock-a',
      model: 'model-a',
      reasoningEffort: 'high',
      command: fixtureCommand(),
    })
    const events = sinkEvents(handle)
    assert.equal(handle.state, 'ready')
    assert.equal(handle.deliveryStatus, 'none')
    assert.equal(handle.route?.provider, 'mock-a')
    assert.equal(handle.route?.model, 'model-a')
    assert.equal(handle.route?.reasoningEffort, 'high')
    assert.ok(handle.sessionId)
    assert.equal(handle.processFacts?.stdoutDisposition, 'pipe')
    assert.equal(handle.processFacts?.stderrDisposition, 'collect')

    const first = await handle.send('first turn')
    assert.equal(first.stopReason, 'end_turn')
    assert.equal(first.promptEnded, true)
    assert.equal(handle.state, 'prompt_ended')
    assert.equal(handle.deliveryStatus, 'pending_acceptance')
    await events.waitFor((event) => event.type === 'prompt_ended')
    const echo = JSON.parse(assistantText(events.items))
    assert.equal(echo.cwd, workspace.cwd)
    assert.equal(echo.dshHome, workspace.dshHome)
    assert.equal(echo.provider, 'mock-a')
    assert.equal(echo.model, 'model-a')
    assert.equal(echo.reasoningEffort, 'high')
    assert.equal(echo.sessionId, handle.sessionId)

    const second = await handle.send('followup')
    assert.equal(second.stopReason, 'end_turn')
    assert.equal(handle.deliveryStatus, 'pending_acceptance')

    await handle.close()
    const outcome = await handle.done
    assert.equal(outcome.state, 'closed')
    assert.equal(outcome.rangeExited, true)
    assert.equal(handle.deliveryStatus, 'pending_acceptance')
  })
})

test('permission is a real ACP request answered by the client', { timeout: 20_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-perm-')
  t.after(workspace.cleanup)
  await withExecutor(async (executor) => {
    const handle = await executor.start({
      cwd: workspace.cwd,
      dshHome: workspace.dshHome,
      provider: 'mock-a',
      model: 'model-a',
      command: fixtureCommand(),
    })
    const events = sinkEvents(handle)
    const pending = handle.send('PERMISSION')
    const permission = await events.waitFor((event) => event.type === 'permission')
    assert.equal(permission.type, 'permission')
    assert.equal(handle.state, 'awaiting_permission')
    await handle.answerPermission(permission.requestId, { optionId: 'allow-once' })
    const receipt = await pending
    assert.equal(receipt.stopReason, 'end_turn')
    assert.match(assistantText(events.items), /"outcome":"selected"/)
    await handle.close()
  })
})

test('session/cancel ends an in-flight prompt without closing the session', { timeout: 20_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-cancel-')
  t.after(workspace.cleanup)
  await withExecutor(async (executor) => {
    const handle = await executor.start({
      cwd: workspace.cwd,
      dshHome: workspace.dshHome,
      provider: 'mock-a',
      model: 'model-a',
      command: fixtureCommand(),
    })
    const events = sinkEvents(handle)
    const slow = handle.send('SLOW')
    await events.waitFor((event) => event.type === 'state' && event.state === 'prompting')
    await handle.cancel()
    const cancelled = await slow
    assert.equal(cancelled.stopReason, 'cancelled')
    assert.equal(handle.deliveryStatus, 'none')
    const follow = await handle.send('after-cancel')
    assert.equal(follow.stopReason, 'end_turn')
    await handle.close()
  })
})

test('unsupported reasoning effort fails before a session is used', { timeout: 20_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-effort-')
  t.after(workspace.cleanup)
  await withExecutor(async (executor) => {
    await assert.rejects(
      () => executor.start({
        cwd: workspace.cwd,
        dshHome: workspace.dshHome,
        provider: 'mock-a',
        model: 'model-a',
        reasoningEffort: 'not-a-real-effort',
        command: fixtureCommand(),
      }),
      /reasoning effort/i,
    )
  })
})

for (const phase of ['initialize', 'new', 'prompt', 'close'] as const) {
  test(`hung ACP ${phase} has a bounded deadline and reaps its managed process tree`, { timeout: 15_000 }, async (t) => {
    const workspace = await makeWorkspace(`lachesis-deadline-${phase}-`)
    t.after(workspace.cleanup)
    const executor = createDshAcpExecutor({
      bindProcessExit: false,
      startupTimeoutMs: 2_000,
      promptTimeoutMs: 200,
      closeTimeoutMs: 200,
      disposeEofGraceMs: 100,
      disposeGraceMs: 100,
      disposeTimeoutMs: 5_000,
    })
    try {
      const startedAt = Date.now()
      const start = executor.start({
        ...workspace, provider: 'mock-a', model: 'model-a', command: fixtureCommand(),
        env: { LACHESIS_FIXTURE_HANG: phase },
      })
      if (phase === 'initialize' || phase === 'new') {
        await assert.rejects(start, /ACP startup timed out/)
      } else {
        const handle = await start
        const events = sinkEvents(handle)
        if (phase === 'prompt') {
          await assert.rejects(handle.send('hang forever'), /ACP prompt timed out/)
          await assert.rejects(handle.send('after deadline'), /cannot send/)
        } else {
          await assert.rejects(handle.close(), /ACP session close timed out/)
        }
        const outcome = await handle.done
        assert.equal(outcome.state, 'failed')
        assert.equal(outcome.rangeExited, true)
        assert.equal(outcome.deliveryStatus, 'none')
        assert.match(outcome.error ?? '', /timed out/)
        assert.equal(events.items.filter((event) => event.type === 'process_exit').length, 1)
      }
      assert.ok(Date.now() - startedAt < 9_000, 'operation must finish without the outer test timeout')
      for (const file of ['agent.pid', 'child.pid']) {
        const pid = Number(await readFile(join(workspace.cwd, file), 'utf8'))
        assert.ok(Number.isInteger(pid) && pid > 0)
        assert.throws(() => process.kill(pid, 0), `${file} still alive after deadline cleanup`)
      }
    } finally {
      await executor.closeAll()
    }
  })
}

test('close interrupts a hung prompt without waiting for its long deadline', { timeout: 15_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-close-prompt-')
  t.after(workspace.cleanup)
  const executor = createDshAcpExecutor({ bindProcessExit: false, disposeEofGraceMs: 100, disposeGraceMs: 100 })
  try {
    const handle = await executor.start({
      ...workspace, provider: 'mock-a', model: 'model-a', command: fixtureCommand(),
      env: { LACHESIS_FIXTURE_HANG: 'prompt' },
    })
    const events = sinkEvents(handle)
    const rejection = assert.rejects(handle.send('never returns'), /ACP run closed/)
    await events.waitFor((event) => event.type === 'state' && event.state === 'prompting')
    await Promise.all([handle.close(), handle.close(), rejection])
    const outcome = await handle.done
    assert.equal(outcome.state, 'closed')
    assert.equal(outcome.rangeExited, true)
    assert.equal(outcome.deliveryStatus, 'none')
    assert.equal(events.items.filter((event) => event.type === 'process_exit').length, 1)
  } finally {
    await executor.closeAll()
  }
})

test('closeAll while the host starts prevents a late worker spawn and permits a clean restart', { timeout: 15_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-start-close-')
  t.after(workspace.cleanup)
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  const spec = { ...workspace, provider: 'mock-a', model: 'model-a', command: fixtureCommand() }
  try {
    const rejection = assert.rejects(executor.start(spec), /executor is closing/)
    await Promise.all([executor.closeAll(), executor.closeAll(), rejection])
    const handle = await executor.start(spec)
    assert.equal(handle.state, 'ready')
    await executor.closeAll()
    assert.equal((await handle.done).rangeExited, true)
  } finally {
    await executor.closeAll()
  }
})
