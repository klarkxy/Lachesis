import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { WorkspaceError } from '../src/index.ts'
import { runVerification } from '../src/verify.ts'
import { commitAll, initGit, makeWorkspace, write } from './helpers.ts'

test('freeze refuses a live worker pid', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-live-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  await commitAll(git, 'init')
  await ctx.ws.prepareRun({ runId: 'run-live', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  })
  t.after(() => {
    child.kill('SIGTERM')
  })
  await new Promise((resolve) => child.once('spawn', resolve))
  assert.ok(child.pid && child.pid > 0)
  await assert.rejects(
    () => ctx.ws.freezeDelivery({
      runId: 'run-live',
      deliveryId: 'del-live',
      worker: { pid: child.pid, rangeExited: true },
    }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'worker_running',
  )
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  const frozen = await ctx.ws.freezeDelivery({
    runId: 'run-live',
    deliveryId: 'del-live',
    worker: { pid: child.pid, rangeExited: true },
  })
  assert.equal(frozen.runId, 'run-live')
})

test('storeRoot inside the project is rejected', { timeout: 20_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-overlap-')
  t.after(ctx.cleanup)
  const inner = await (await import('../src/index.ts')).Workspace.create({
    storeRoot: join(ctx.projectRoot, 'store'),
  })
  await write(ctx.projectRoot, 'app.js', 'x\n')
  await assert.rejects(
    () => inner.prepareRun({
      runId: 'run-x',
      kind: 'files',
      projectRoot: ctx.projectRoot,
      targetBranch: null,
    }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'invalid_path',
  )
})

test('delivery file reads reject path escape', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-esc-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  const prepared = await ctx.ws.prepareRun({
    runId: 'run-e',
    kind: 'files',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
  })
  await writeFile(join(prepared.workspacePath, 'app.js'), 'y\n')
  await ctx.ws.freezeDelivery({ runId: 'run-e', deliveryId: 'del-e', worker: { rangeExited: true } })
  await assert.rejects(() => ctx.ws.readDeliveryFile('del-e', '../store/blobs/aa/bb'), WorkspaceError)
  await assert.rejects(() => ctx.ws.readDeliveryFile('del-e', 'missing.js'), WorkspaceError)
})

test('Windows batch verification runs with spaces and rejects command injection', { timeout: 30_000, skip: process.platform !== 'win32' }, async (t) => {
  const ctx = await makeWorkspace('lachesis-cmd-')
  t.after(ctx.cleanup)
  const script = join(ctx.root, 'verify safely.cmd')
  await writeFile(script, '@echo off\r\necho verified:%~1\r\n', 'utf8')
  const passed = await runVerification(ctx.projectRoot, [script, 'two words'])
  assert.equal(passed.outcome, 'passed')
  assert.match(passed.detail ?? '', /verified:two words/)
  const refused = await runVerification(ctx.projectRoot, [script, 'safe & echo injected'])
  assert.equal(refused.outcome, 'failed')
  assert.match(refused.detail ?? '', /Unsafe Windows batch command/)
})
