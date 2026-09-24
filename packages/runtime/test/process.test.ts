import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDshAcpExecutor, disposeAcpChild } from '../src/index.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { fixtureCommand, makeWorkspace, sinkEvents, withExecutor } from './helpers.ts'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('final subprocess exit observation is bounded and reports unconfirmed exit', { timeout: 2_000 }, async () => {
  let terminated = false
  let waits = 0
  const child = {
    terminate: () => { terminated = true },
    waitForExit: (signal?: AbortSignal) => {
      waits++
      assert.ok(signal, 'every exit wait must have a deadline')
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true })
      })
    },
  } as unknown as SubprocessHandle
  await assert.rejects(disposeAcpChild(child, 10, 20), /managed range exit is unconfirmed/)
  assert.equal(terminated, true)
  assert.equal(waits, 2)
})

test('invalid deadline configuration is rejected instead of disabling timeouts', () => {
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) {
    assert.throws(() => createDshAcpExecutor({ bindProcessExit: false, promptTimeoutMs: value }), /positive finite integer/)
  }
})

test('refuses the user ~/.dsh home', async () => {
  await withExecutor(async (executor) => {
    await assert.rejects(
      () => executor.start({
        cwd: process.cwd(),
        dshHome: join(homedir(), '.dsh'),
        provider: 'x',
        model: 'y',
        command: fixtureCommand(),
      }),
      /isolated home/,
    )
  })
})

test('child stderr is redacted and stdout stays the ACP pipe', { timeout: 20_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-log-')
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
    await handle.send('SECRET')
    const log = await events.waitFor((event) => event.type === 'log')
    assert.equal(log.type, 'log')
    assert.match(log.text, /DEEPSEEK_API_KEY=\[redacted\]/)
    assert.doesNotMatch(log.text, /sk-test-not-a-real-secret/)
    await handle.close()
  })
})

test('closeAll reaps workers; optional Job descendant is observed', { timeout: 40_000 }, async (t) => {
  const workspace = await makeWorkspace('lachesis-job-')
  t.after(workspace.cleanup)
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  try {
    const handle = await executor.start({
      cwd: workspace.cwd,
      dshHome: workspace.dshHome,
      provider: 'mock-a',
      model: 'model-a',
      command: fixtureCommand(),
    })
    assert.equal(typeof handle.processFacts?.controlChannelPresent, 'boolean')
    await handle.send('CHILD')
    const pidPath = join(workspace.cwd, 'child.pid')
    assert.equal(existsSync(pidPath), true)
    const pid = Number(await readFile(pidPath, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0)
    await executor.closeAll()
    const outcome = await handle.done
    assert.equal(outcome.rangeExited, true)
    // Job containment is recorded, not assumed: a descendant that Node
    // could not place in the range may still be alive on fallback.
    t.diagnostic(`controlChannelPresent=${String(handle.processFacts?.controlChannelPresent)} grandchildAlive=${String(pidAlive(pid))}`)
  } finally {
    await executor.closeAll()
  }
})

test('Windows native Job stops worker and descendant after an ungraceful runtime-parent crash', {
  timeout: 25_000, skip: process.platform !== 'win32',
}, async (t) => {
  const workspace = await makeWorkspace('lachesis-parent-crash-')
  const parent = spawn(process.execPath, [
    '--experimental-strip-types', fileURLToPath(new URL('./fixtures/crash-parent.mjs', import.meta.url)),
    workspace.cwd, workspace.dshHome,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  parent.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_000) })
  const pids: number[] = []
  try {
    const launch = await new Promise<{ runnerPid: number; runnerEntry: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`crash fixture did not start: ${stderr}`)), 10_000)
      parent.once('message', (message) => { clearTimeout(timeout); resolve(message as { runnerPid: number; runnerEntry: string }) })
      parent.once('error', (error) => { clearTimeout(timeout); reject(error) })
      parent.once('exit', () => { clearTimeout(timeout); reject(new Error(`crash fixture exited early: ${stderr}`)) })
    })
    for (const file of ['agent-parent.pid', 'agent.pid', 'child.pid']) {
      pids.push(Number(await readFile(join(workspace.cwd, file), 'utf8')))
    }
    const [runnerPid] = pids
    assert.ok(runnerPid && runnerPid !== parent.pid, 'worker must be launched by the native runner, not directly by fallback')
    const nativeRunner = await realpath(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')))
    assert.equal(launch.runnerEntry, nativeRunner)
    assert.equal(launch.runnerPid, runnerPid, 'actual native runner PID must match the ACP worker parent PID')
    assert.doesNotMatch(stderr, /weaker process-tree containment/)
    const heartbeatPath = join(workspace.cwd, 'heartbeat.txt')
    const heartbeatDeadline = Date.now() + 5_000
    while (!existsSync(heartbeatPath) && Date.now() < heartbeatDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const before = await readFile(heartbeatPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.notEqual(await readFile(heartbeatPath, 'utf8'), before, 'descendant must be active before parent crash')
    parent.kill('SIGKILL')
    const deadline = Date.now() + 5_000
    while (pids.some(pidAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    for (const pid of pids) assert.equal(pidAlive(pid), false, `PID ${pid} survived its runtime parent`)
    const stopped = await readFile(heartbeatPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await readFile(heartbeatPath, 'utf8'), stopped, 'descendant heartbeat must remain stopped')
    t.diagnostic('native Job runner identity confirmed; forced runtime-parent kill reaped runner, ACP worker and active descendant')
  } finally {
    parent.kill('SIGKILL')
    for (const file of ['agent-parent.pid', 'agent.pid', 'child.pid']) {
      try {
        const pid = Number(await readFile(join(workspace.cwd, file), 'utf8'))
        if (pid !== parent.pid && Number.isInteger(pid) && pid > 0 && pidAlive(pid)) process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await workspace.cleanup()
  }
})
