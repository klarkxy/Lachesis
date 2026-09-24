import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import { DshAcpRuntime, RangeExitUnconfirmedError, RuntimeEnvironmentError, classifyRuntimeEnvironmentError } from '../src/index.ts'
import { checkToolReadiness, createToolProbeBackend, readinessIdentity, type ToolProbeBackend } from '../src/readiness.ts'
import { makeWorkspace } from './helpers.ts'
import { AcpRun } from '../src/run.ts'

function fakeBackend(options: { shellError?: Error; sandbox?: boolean; skipWrite?: boolean; disposeError?: Error; deleteError?: boolean } = {}) {
  let probePath = ''
  let marker = ''
  let commands = 0
  let disposed = false
  const backend: ToolProbeBackend = {
    write: async (path, content) => { probePath = path; marker = content; await writeFile(path, content, { flag: 'wx' }) },
    read: async (path) => readFile(path, 'utf8'),
    command: async () => {
      commands++
      if (options.shellError) throw options.shellError
      if (commands === 1 && !options.skipWrite) await writeFile(probePath, `${marker}-command`)
      if (commands === 2 && !options.deleteError) await unlink(probePath)
      return {
        exitCode: 0, signal: null, timedOut: false, aborted: false,
        stdout: { text: marker, truncated: false }, stderr: { text: '', truncated: false },
        ...(options.sandbox === false ? {} : { sandbox: { mode: 'workspace-write', enforcement: 'partial', denied: false } }),
      } as ShellRunResult
    },
    dispose: async () => { disposed = true; if (options.disposeError) throw options.disposeError },
  }
  return { backend, get commands() { return commands }, get disposed() { return disposed } }
}

test('readiness requires both real write paths, expected readback, deletion and cleanup', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-success-')
  t.after(spec.cleanup)
  const fake = fakeBackend()
  assert.deepEqual(await checkToolReadiness(spec, 3_000, async () => fake.backend), { ready: true, code: null, diagnostic: null })
  assert.equal(fake.commands, 2)
  assert.equal(fake.disposed, true)
  assert.deepEqual(await readdir(spec.cwd), [])
})

test('readiness rejects a host-shell success and a forged write/delete receipt', async (t) => {
  for (const options of [{ sandbox: false }, { skipWrite: true }, { deleteError: true }]) {
    const spec = await makeWorkspace('lachesis-ready-evidence-')
    t.after(spec.cleanup)
    const fake = fakeBackend(options)
    const result = await checkToolReadiness(spec, 3_000, async () => fake.backend)
    assert.equal(result.ready, false)
    assert.equal(fake.disposed, true)
    assert.deepEqual(await readdir(spec.cwd), [])
  }
})

test('WRITE_OWNER tool-init fault is distinct, redacted, and cleans the exact probe', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-acl-')
  t.after(spec.cleanup)
  await writeFile(join(spec.cwd, 'keep.txt'), 'keep')
  const fake = fakeBackend({ shellError: new Error('windows-acl-run: SetNamedSecurityInfoW failed (Win32 5); TOKEN=secret-example') })
  const result = await checkToolReadiness(spec, 3_000, async () => fake.backend)
  assert.equal(result.ready, false)
  assert.equal(result.code, 'sandbox_write_grant_failed')
  assert.match(result.diagnostic!, /Win32 5/)
  assert.ok(!result.diagnostic!.includes('secret-example'))
  assert.deepEqual(await readdir(spec.cwd), ['keep.txt'])
})

test('unconfirmed range disposal rejects instead of claiming readiness or deleting evidence', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-range-')
  t.after(spec.cleanup)
  const fake = fakeBackend({ shellError: new Error('probe interrupted'), disposeError: new Error('descendant still alive') })
  await assert.rejects(checkToolReadiness(spec, 3_000, async () => fake.backend), RangeExitUnconfirmedError)
  assert.equal((await readdir(spec.cwd)).length, 1)
})

test('partially initialized composition retains both failures and unconfirmed range semantics', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-partial-init-')
  t.after(spec.cleanup)
  const initializationError = new Error('injected plugin initialization failure')
  const cleanupError = new Error('injected owned-range disposal failure')
  let mounted = 0
  let disposed = false
  const context = {
    plugin: async () => {
      // Mount the subprocess service, then fail a later component.
      if (++mounted > 1) throw initializationError
    },
    fiber: { dispose: async () => { disposed = true; throw cleanupError } },
  } as unknown as Context
  await assert.rejects(checkToolReadiness(spec, 3_000, (input, timeout) =>
    createToolProbeBackend(input, timeout, () => context)), (error: unknown) => {
    assert.ok(error instanceof RangeExitUnconfirmedError)
    assert.ok(error.cause instanceof AggregateError)
    assert.deepEqual(error.cause.errors, [initializationError, cleanupError])
    return true
  })
  assert.equal(mounted, 2)
  assert.equal(disposed, true)
  assert.deepEqual(await readdir(spec.cwd), [])
})

test('readiness refuses default homes before tool composition and fingerprints config metadata only', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-paths-')
  t.after(spec.cleanup)
  let invoked = false
  const result = await checkToolReadiness({ cwd: homedir(), dshHome: spec.dshHome }, 3_000, async () => {
    invoked = true
    return fakeBackend().backend
  })
  assert.equal(result.ready, false)
  assert.equal(invoked, false)
  const before = await readinessIdentity(spec)
  await writeFile(join(spec.dshHome, 'cordis.patch.yml'), 'example: changed')
  assert.notEqual(await readinessIdentity(spec), before)
})

test('production start cannot bypass failed readiness or launch ACP first', async (t) => {
  const runtime = new DshAcpRuntime({ bindProcessExit: false })
  t.after(() => runtime.closeAll())
  let checks = 0
  t.mock.method(runtime, 'checkReadiness', async () => {
    checks++
    return { ready: false, code: 'sandbox_write_grant_failed', diagnostic: 'WRITE_OWNER unavailable' }
  })
  await assert.rejects(runtime.start({ cwd: '/unused', dshHome: '/unused-home', provider: 'unused', model: 'unused' }), RuntimeEnvironmentError)
  assert.equal(checks, 1)
})

test('classifier follows error causes but does not turn provider or command errors into environment faults', () => {
  assert.equal(classifyRuntimeEnvironmentError(new Error('HTTP 429 provider busy')), null)
  assert.equal(classifyRuntimeEnvironmentError(new Error('test assertion failed')), null)
  assert.equal(classifyRuntimeEnvironmentError(new Error('startup', { cause: new Error('SetNamedSecurityInfoW failed with Win32 5') }))?.code, 'sandbox_write_grant_failed')
})

test('successful readiness is consumed once and invalidated by config changes, without duplicate probes', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-receipt-')
  t.after(spec.cleanup)
  const runtime = new DshAcpRuntime({ bindProcessExit: false })
  t.after(() => runtime.closeAll())
  let commands = 0
  const prototype = process.platform === 'win32' ? SandboxPwshExecutor.prototype : SandboxBashExecutor.prototype
  t.mock.method(prototype, 'execute', async (request) => {
    commands++
    const name = request.command.match(/\.lachesis-readiness-([a-f0-9-]+)\.txt/)
    assert.ok(name)
    const path = join(spec.cwd, name[0])
    const marker = name[1]
    if (/Remove-Item|rm --/.test(request.command)) await unlink(path)
    else await writeFile(path, `${marker}-command`)
    return { result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { text: marker, truncated: false }, stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', enforcement: 'partial', denied: false },
    }) }
  })
  // Prevent any ACP transport/model/provider initialization in this receipt test.
  t.mock.method(AcpRun.prototype, 'activate', async () => {})
  const runSpec = { ...spec, provider: 'unused', model: 'unused' }
  assert.equal((await runtime.checkReadiness(spec)).ready, true)
  assert.equal(commands, 2)
  await (await runtime.start(runSpec)).close()
  assert.equal(commands, 2, 'start consumes the existing fresh proof')
  await (await runtime.start(runSpec)).close()
  assert.equal(commands, 4, 'proof is consumed, not reused indefinitely')
  assert.equal((await runtime.checkReadiness(spec)).ready, true)
  await writeFile(join(spec.dshHome, 'cordis.patch.yml'), 'changed: true')
  await (await runtime.start(runSpec)).close()
  assert.equal(commands, 8, 'config metadata changes force another actual tool probe')
})

test('a configuration change during the probe is rejected', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-race-')
  t.after(spec.cleanup)
  const fake = fakeBackend()
  const command = fake.backend.command
  fake.backend.command = async (...args) => {
    await writeFile(join(spec.dshHome, 'cordis.patch.yml'), 'changed: true')
    return command(...args)
  }
  const result = await checkToolReadiness(spec, 3_000, async () => fake.backend)
  assert.equal(result.ready, false)
  assert.match(result.diagnostic!, /changed during tool preflight/)
})

test('probe cancellation waits for backend cleanup and never reports ready', async (t) => {
  const spec = await makeWorkspace('lachesis-ready-timeout-')
  t.after(spec.cleanup)
  const fake = fakeBackend()
  fake.backend.command = async (_, signal) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const result = await checkToolReadiness(spec, 100, async () => fake.backend)
  assert.equal(result.ready, false)
  assert.match(result.diagnostic!, /timed out/)
  assert.equal(fake.disposed, true)
  assert.deepEqual(await readdir(spec.cwd), [])
})

test('installed pinned dsh tool backends either execute confined writes or report an actual environment denial, without a model', { timeout: 60_000 }, async (t) => {
  const spec = await makeWorkspace('lachesis-ready-native-')
  t.after(spec.cleanup)
  const result = await checkToolReadiness(spec, 20_000)
  t.diagnostic(JSON.stringify(result))
  if (!result.ready) {
    assert.ok(['sandbox_write_grant_failed', 'sandbox_unavailable', 'process_containment_unavailable'].includes(result.code!), result.diagnostic!)
  }
  assert.deepEqual(await readdir(spec.cwd), [])
})
