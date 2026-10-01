import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
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

/**
 * Walk a live process's real ancestor chain. The confined worker is no longer a
 * direct child of the subprocess-local Job runner — the sandbox wrap sits
 * between them — so containment is proved by ancestry, not by one PID edge.
 */
function ancestorsOf(pid: number): number[] {
  const chain: number[] = []
  let current = pid
  for (let depth = 0; depth < 16; depth += 1) {
    let stdout = ''
    try {
      stdout = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${current}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    } catch {
      break
    }
    const parsed = Number(stdout.trim())
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed === 4) break
    chain.push(parsed)
    current = parsed
  }
  return chain
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
    const [agentParentPid] = pids
    const runnerPid = launch.runnerPid
    assert.ok(runnerPid && runnerPid !== parent.pid, 'worker must be launched by the native runner, not directly by fallback')
    const nativeRunner = await realpath(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')))
    assert.equal(launch.runnerEntry, nativeRunner)
    // The Run is spawned confined, so the native Job runner now owns a sandbox
    // wrap that in turn owns the worker. Containment is the whole chain, so
    // assert the chain rather than one direct-parent edge.
    const chain = ancestorsOf(agentParentPid)
    t.diagnostic(`workerAncestry=${JSON.stringify([agentParentPid, ...chain])} jobRunner=${runnerPid}`)
    assert.ok(chain.includes(runnerPid),
      `the native Job runner ${runnerPid} must be an ancestor of the confined worker, saw ${JSON.stringify(chain)}`)
    assert.ok(chain.includes(parent.pid), 'the crashed runtime parent must be the root of the worker chain')
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
