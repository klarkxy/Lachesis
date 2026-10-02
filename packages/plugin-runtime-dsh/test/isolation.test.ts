import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assistantText, fixtureCommand, makeWorkspace, sinkEvents, withExecutor } from './helpers.ts'

test('two runs keep isolated cwd, DSH_HOME, session, and vendor route', { timeout: 40_000 }, async (t) => {
  const left = await makeWorkspace('lachesis-left-')
  const right = await makeWorkspace('lachesis-right-')
  t.after(async () => {
    await left.cleanup()
    await right.cleanup()
  })
  await withExecutor(async (executor) => {
    const runA = await executor.start({
      cwd: left.cwd,
      dshHome: left.dshHome,
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low',
      command: fixtureCommand(),
    })
    const runB = await executor.start({
      cwd: right.cwd,
      dshHome: right.dshHome,
      provider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'max',
      command: fixtureCommand(),
    })
    const eventsA = sinkEvents(runA)
    const eventsB = sinkEvents(runB)
    assert.notEqual(runA.sessionId, runB.sessionId)
    assert.notEqual(runA.runId, runB.runId)

    await runA.send('from-a')
    await runB.send('from-b')
    const echoA = JSON.parse(assistantText(eventsA.items))
    const echoB = JSON.parse(assistantText(eventsB.items))
    assert.equal(echoA.cwd, left.cwd)
    assert.equal(echoB.cwd, right.cwd)
    assert.equal(echoA.dshHome, left.dshHome)
    assert.equal(echoB.dshHome, right.dshHome)
    assert.equal(echoA.provider, 'provider-a')
    assert.equal(echoB.provider, 'provider-b')
    assert.equal(echoA.model, 'model-a')
    assert.equal(echoB.model, 'model-b')
    assert.notEqual(echoA.sessionId, echoB.sessionId)

    await runA.cancel()
    const follow = await runB.send('still-alive')
    assert.equal(follow.stopReason, 'end_turn')
    await runA.close()
    await runB.close()
  })
})
