import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { checkDeliveryScope } from '../src/index.ts'
import { spawnArgv } from '../src/spawn.ts'
import { makeWorkspace, stopped, write } from './helpers.ts'

test('scope checks exact files, subtree ownership and read-only exclusions', () => {
  const files = ['src/a.ts', 'src/nested/b.ts', 'src2/a.ts', 'README.md'].map((path) => ({ path }))
  assert.deepEqual(checkDeliveryScope(files, ['src/', 'README.md'], ['src/nested/']),
    ['src/nested/b.ts', 'src2/a.ts'])
  assert.deepEqual(checkDeliveryScope(files, [], ['README.md']), ['README.md'])
  assert.throws(() => checkDeliveryScope(files, ['../outside'], []))
  assert.throws(() => checkDeliveryScope(files, ['src/*.ts'], []))
  assert.deepEqual(checkDeliveryScope([{ path: '../escape' }], [], []), ['../escape'])
  if (process.platform === 'win32') {
    assert.deepEqual(checkDeliveryScope([{ path: 'SRC/Secret.ts' }], [], ['src/']), ['SRC/Secret.ts'])
    assert.deepEqual(checkDeliveryScope([{ path: 'SRC/Allowed.ts' }], ['src/'], []), [])
  }
})

test('canonical target lock serializes aliases and nested roots', async (t) => {
  const ctx = await makeWorkspace('lachesis-lock-')
  t.after(ctx.cleanup)
  const alias = resolve(ctx.projectRoot, '..', 'project')
  assert.equal(await ctx.ws.targetKey(alias), await ctx.ws.targetKey(ctx.projectRoot))
  await write(ctx.projectRoot, 'sub/keep.txt', 'x')
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  let entered!: () => void
  const firstEntered = new Promise<void>((done) => { entered = done })
  const events: string[] = []
  const first = ctx.ws.withTargetLock(ctx.projectRoot, async () => {
    events.push('first-enter')
    entered()
    await gate
    events.push('first-exit')
  })
  await firstEntered
  const second = ctx.ws.withTargetLock(join(ctx.projectRoot, 'sub'), async () => {
    events.push('second-enter')
  })
  await new Promise((done) => setTimeout(done, 50))
  assert.deepEqual(events, ['first-enter'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter'])
})

test('files candidate rejects drift in an untouched file', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-digest-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'changed.txt', 'base')
  await write(ctx.projectRoot, 'untouched.txt', 'old')
  const run = await ctx.ws.prepareRun({ runId: 'run-digest', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'changed.txt', 'candidate')
  await ctx.ws.freezeDelivery({ runId: 'run-digest', deliveryId: 'del-digest', worker: stopped })
  const integrated = await ctx.ws.integrate({ applicationId: 'app-digest', deliveryId: 'del-digest',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  await write(ctx.projectRoot, 'untouched.txt', 'external')
  const applied = await ctx.ws.apply({ applicationId: 'app-digest', expectedTarget: integrated.expectedTarget,
    verificationCommand: null })
  assert.equal(applied.status, 'failed')
  assert.match(applied.diagnostic ?? '', /external changes/)
  assert.equal(await readFile(join(ctx.projectRoot, 'changed.txt'), 'utf8'), 'base')
})

test('legacy candidate requires reprepare and rework refuses a modified baseline', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-legacy-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.txt', 'base')
  const run = await ctx.ws.prepareRun({ runId: 'run-legacy', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'app.txt', 'candidate')
  await ctx.ws.freezeDelivery({ runId: 'run-legacy', deliveryId: 'del-legacy', worker: stopped })
  const integrated = await ctx.ws.integrate({ applicationId: 'app-legacy', deliveryId: 'del-legacy',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  const metadata = join(ctx.storeRoot, 'integrations', 'app-legacy', 'meta.json')
  const record = JSON.parse(await readFile(metadata, 'utf8')) as Record<string, unknown>
  delete record.targetDigest
  await writeFile(metadata, JSON.stringify(record))
  const applied = await ctx.ws.apply({ applicationId: 'app-legacy', expectedTarget: integrated.expectedTarget,
    verificationCommand: null })
  assert.equal(applied.status, 'failed')
  assert.match(applied.diagnostic ?? '', /reprepare|new candidate/i)
  assert.equal(await readFile(join(ctx.projectRoot, 'app.txt'), 'utf8'), 'base')
  await write(run.baselinePath!, 'app.txt', 'tampered')
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-rework', kind: 'files',
    projectRoot: ctx.projectRoot, targetBranch: null, seedDeliveryId: 'del-legacy' }),
  /baseline no longer matches/)
})

test('snapshot refuses linked managed files before copying', async (t) => {
  const ctx = await makeWorkspace('lachesis-linked-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'real.txt', 'real')
  try { await symlink(join(ctx.projectRoot, 'real.txt'), join(ctx.projectRoot, 'link.txt')) }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-link', kind: 'files',
    projectRoot: ctx.projectRoot, targetBranch: null }), /symbolic link/)
})

test('verification retains late failure, bounds output and redacts secret', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-verify-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.txt', 'base')
  const run = await ctx.ws.prepareRun({ runId: 'run-verify', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'app.txt', 'candidate')
  await ctx.ws.freezeDelivery({ runId: 'run-verify', deliveryId: 'del-verify', worker: stopped })
  const secret = 'lachesis-test-secret-123456'
  const jsonPassword = 'synthetic-review-password-123'
  const jsonToken = 'synthetic-review-token-456'
  const code = `process.stdout.write('a'.repeat(1200000)); process.stderr.write('\\nnot ok late case\\nError: expected 1 actual 2\\nBearer ${secret}\\n' + JSON.stringify({password:'${jsonPassword}',access_token:'${jsonToken}'})); process.exit(1)`
  const result = await ctx.ws.integrate({ applicationId: 'app-verify', deliveryId: 'del-verify',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: [process.execPath, '-e', code] })
  assert.equal(result.status, 'failed')
  const report = await ctx.ws.readVerification('app-verify')
  assert.ok(report)
  assert.equal(report.truncated, true)
  assert.ok(report.omittedBytes > 0)
  assert.ok(Buffer.byteLength(report.output) < 1024 * 1024)
  assert.match(report.summary, /late case/)
  assert.match(report.summary, /expected 1 actual 2/)
  assert.doesNotMatch(report.output, new RegExp(secret))
  assert.doesNotMatch(report.output, new RegExp(jsonPassword))
  assert.doesNotMatch(report.output, new RegExp(jsonToken))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(jsonPassword))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(jsonToken))
  assert.doesNotMatch(result.diagnostic ?? '', new RegExp(secret))
  assert.doesNotMatch(result.diagnostic ?? '', new RegExp(jsonPassword))
  assert.doesNotMatch(result.diagnostic ?? '', new RegExp(jsonToken))
  assert.equal(report.exitCode, 1)
  assert.equal(report.command[0], process.execPath)
  assert.ok((await readFile(join(ctx.storeRoot, 'integrations', 'app-verify', 'verification.json'), 'utf8')).includes('late case'))
})

test('verification readback chooses apply phase after successful apply', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-verify-phase-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.txt', 'base')
  const run = await ctx.ws.prepareRun({ runId: 'run-phase', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'app.txt', 'candidate')
  await ctx.ws.freezeDelivery({ runId: 'run-phase', deliveryId: 'del-phase', worker: stopped })
  const integrated = await ctx.ws.integrate({ applicationId: 'app-phase', deliveryId: 'del-phase',
    projectRoot: ctx.projectRoot, targetBranch: null,
    verificationCommand: [process.execPath, '-e', "console.log('integration-phase')"] })
  assert.equal(integrated.status, 'ready')
  assert.match((await ctx.ws.readVerification('app-phase'))?.output ?? '', /integration-phase/)
  const applied = await ctx.ws.apply({ applicationId: 'app-phase', expectedTarget: integrated.expectedTarget,
    verificationCommand: [process.execPath, '-e', "console.log('apply-phase')"] })
  assert.equal(applied.status, 'applied')
  assert.match((await ctx.ws.readVerification('app-phase'))?.output ?? '', /apply-phase/)
})

test('timed-out verification process never reports a successful completion', { timeout: 20_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-timeout-')
  t.after(ctx.cleanup)
  try {
    const result = await spawnArgv(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: ctx.projectRoot, timeoutMs: 200, allowFailure: true,
    })
    assert.equal(result.code, null)
    assert.equal(result.signal, 'SIGKILL')
  } catch (error) {
    // Hosts that deny process-tree cleanup must retain the recovery fence.
    assert.equal((error as { code?: string }).code, 'recovery_required')
  }
})
