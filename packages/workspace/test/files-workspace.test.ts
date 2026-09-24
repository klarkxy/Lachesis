import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeWorkspace, stopped, verifyNotContaining, write } from './helpers.ts'
import { restoreFiles } from '../src/apply.ts'
import { hashFile } from '../src/hash.ts'

test('files: two tickets snapshot independently', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-par-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, '.gitignore', '*.log\n')
  await write(ctx.projectRoot, 'app.js', 'base\n')
  await write(ctx.projectRoot, 'keep.txt', 'keep\n')

  const a = await ctx.ws.prepareRun({ runId: 'run-a', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  const b = await ctx.ws.prepareRun({ runId: 'run-b', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  assert.notEqual(a.workspacePath, b.workspacePath)
  assert.ok(a.baseRef?.startsWith('files:'))
  await write(a.workspacePath, 'a-only.js', 'A\n')
  await write(b.workspacePath, 'b-only.js', 'B\n')
  const frozenA = await ctx.ws.freezeDelivery({ runId: 'run-a', deliveryId: 'del-a', worker: stopped })
  const frozenB = await ctx.ws.freezeDelivery({ runId: 'run-b', deliveryId: 'del-b', worker: stopped })
  assert.ok(frozenA.files.some((file) => file.path === 'a-only.js'))
  assert.equal(frozenA.files.some((file) => file.path === 'b-only.js'), false)
  assert.ok(frozenB.files.some((file) => file.path === 'b-only.js'))
})

test('files: rework starts with the frozen prior delivery and keeps cumulative changes', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-rework-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'base.txt', 'base\n')
  const first = await ctx.ws.prepareRun({ runId: 'run-first', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(first.workspacePath, 'first.txt', 'first\n')
  await ctx.ws.freezeDelivery({ runId: 'run-first', deliveryId: 'del-first', worker: stopped })
  const second = await ctx.ws.prepareRun({ runId: 'run-second', kind: 'files', projectRoot: ctx.projectRoot,
    targetBranch: null, seedDeliveryId: 'del-first' })
  assert.equal(await readFile(join(second.workspacePath, 'first.txt'), 'utf8'), 'first\n')
  await write(second.workspacePath, 'second.txt', 'second\n')
  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-second', deliveryId: 'del-second', worker: stopped })
  assert.deepEqual(frozen.files.map((file) => file.path).sort(), ['first.txt', 'second.txt'])
  const integrated = await ctx.ws.integrate({ applicationId: 'app-second', deliveryId: 'del-second',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({ applicationId: 'app-second', expectedTarget: integrated.expectedTarget,
    verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'first.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'second.txt'), 'utf8'), 'second\n')
})

test('files: rework retains the original merge base and conflicts with external edits', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-rework-conflict-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.txt', 'original\n')
  const first = await ctx.ws.prepareRun({ runId: 'run-first', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(first.workspacePath, 'app.txt', 'worker\n')
  await ctx.ws.freezeDelivery({ runId: 'run-first', deliveryId: 'del-first', worker: stopped })
  await write(ctx.projectRoot, 'app.txt', 'external\n')
  const second = await ctx.ws.prepareRun({ runId: 'run-second', kind: 'files', projectRoot: ctx.projectRoot,
    targetBranch: null, seedDeliveryId: 'del-first' })
  assert.equal(await readFile(join(second.baselinePath!, 'app.txt'), 'utf8'), 'original\n')
  assert.equal(await readFile(join(second.workspacePath, 'app.txt'), 'utf8'), 'worker\n')
  await ctx.ws.freezeDelivery({ runId: 'run-second', deliveryId: 'del-second', worker: stopped })
  const result = await ctx.ws.integrate({ applicationId: 'app-rework-conflict', deliveryId: 'del-second',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(result.status, 'conflict')
  assert.equal(await readFile(join(ctx.projectRoot, 'app.txt'), 'utf8'), 'external\n')
})

test('files: interrupted apply preserves the original backup and refuses replay', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-interrupted-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.txt', 'original\n')
  const run = await ctx.ws.prepareRun({ runId: 'run-interrupted', kind: 'files',
    projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'app.txt', 'candidate\n')
  await ctx.ws.freezeDelivery({ runId: 'run-interrupted', deliveryId: 'del-interrupted', worker: stopped })
  const integrated = await ctx.ws.integrate({ applicationId: 'app-interrupted', deliveryId: 'del-interrupted',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applyDir = join(ctx.storeRoot, 'apply', 'app-interrupted')
  await write(applyDir, 'backup/app.txt', 'original\n')
  await write(applyDir, 'apply.jsonl', '{"op":"start"}\n')
  await write(ctx.projectRoot, 'app.txt', 'candidate\n')
  await assert.rejects(
    ctx.ws.apply({ applicationId: 'app-interrupted', expectedTarget: integrated.expectedTarget,
      verificationCommand: null }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'recovery_required',
  )
  assert.equal(await readFile(join(applyDir, 'backup', 'app.txt'), 'utf8'), 'original\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'app.txt'), 'utf8'), 'candidate\n')
})

test('files: freeze untracked/binary/delete; filter ignored and secrets', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-frz-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, '.gitignore', '*.log\n')
  await write(ctx.projectRoot, 'app.js', 'base\n')
  await write(ctx.projectRoot, 'gone.js', 'bye\n')
  const prepared = await ctx.ws.prepareRun({
    runId: 'run-1',
    kind: 'files',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
  })
  await write(prepared.workspacePath, 'app.js', 'changed\n')
  await write(prepared.workspacePath, 'new.js', 'untracked\n')
  await write(prepared.workspacePath, 'noise.log', 'ignored\n')
  await write(prepared.workspacePath, '.env', 'SECRET=1\n')
  await write(prepared.workspacePath, 'blob.bin', Buffer.from([0, 9, 0]))
  const { rm } = await import('node:fs/promises')
  await rm(join(prepared.workspacePath, 'gone.js'))
  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-1', deliveryId: 'del-1', worker: stopped })
  const kinds = Object.fromEntries(frozen.files.map((file) => [file.path, file]))
  assert.equal(kinds['app.js']?.kind, 'modified')
  assert.equal(kinds['new.js']?.kind, 'added')
  assert.equal(kinds['gone.js']?.kind, 'deleted')
  assert.equal(kinds['blob.bin']?.binary, true)
  assert.equal(kinds['noise.log'], undefined)
  assert.equal(kinds['.env'], undefined)
})

test('files: three-way merge via git, conflict kept, verify always runs', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-int-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  const prepared = await ctx.ws.prepareRun({
    runId: 'run-c',
    kind: 'files',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
  })
  await write(prepared.workspacePath, 'app.js', 'from-worker\n')
  await ctx.ws.freezeDelivery({ runId: 'run-c', deliveryId: 'del-c', worker: stopped })
  await write(ctx.projectRoot, 'app.js', 'from-target\n')
  const conflicted = await ctx.ws.integrate({
    applicationId: 'app-c',
    deliveryId: 'del-c',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
    verificationCommand: null,
  })
  assert.equal(conflicted.status, 'conflict')
  assert.ok(conflicted.conflictPaths.includes('app.js'))

  const ctx2 = await makeWorkspace('lachesis-files-ver-')
  t.after(ctx2.cleanup)
  await write(ctx2.projectRoot, 'app.js', 'base\n')
  const p2 = await ctx2.ws.prepareRun({
    runId: 'run-v',
    kind: 'files',
    projectRoot: ctx2.projectRoot,
    targetBranch: null,
  })
  await write(p2.workspacePath, 'app.js', 'clean\nBAD\n')
  await ctx2.ws.freezeDelivery({ runId: 'run-v', deliveryId: 'del-v', worker: stopped })
  const failed = await ctx2.ws.integrate({
    applicationId: 'app-v',
    deliveryId: 'del-v',
    projectRoot: ctx2.projectRoot,
    targetBranch: null,
    verificationCommand: verifyNotContaining('app.js', 'BAD'),
  })
  assert.equal(failed.status, 'failed')
  assert.ok(failed.evidence.some((item) => item.kind === 'verification' && item.outcome === 'failed'))
  const refused = await ctx2.ws.apply({
    applicationId: 'app-v',
    expectedTarget: failed.expectedTarget,
    verificationCommand: null,
  })
  assert.equal(refused.status, 'failed')
  assert.match(refused.diagnostic ?? '', /Candidate is failed/)
  assert.equal(await readFile(join(ctx2.projectRoot, 'app.js'), 'utf8'), 'base\n')
})

test('files: candidate bytes are checked before apply and missing backups never delete originals', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-integrity-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'original\n')
  const prepared = await ctx.ws.prepareRun({ runId: 'run-integrity', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(prepared.workspacePath, 'app.js', 'candidate\n')
  await ctx.ws.freezeDelivery({ runId: 'run-integrity', deliveryId: 'del-integrity', worker: stopped })
  const integrated = await ctx.ws.integrate({
    applicationId: 'app-integrity', deliveryId: 'del-integrity', projectRoot: ctx.projectRoot,
    targetBranch: null, verificationCommand: null,
  })
  assert.equal(integrated.status, 'ready')
  await write(integrated.integrationPath, 'app.js', 'tampered\n')
  const refused = await ctx.ws.apply({
    applicationId: 'app-integrity', expectedTarget: integrated.expectedTarget, verificationCommand: null,
  })
  assert.equal(refused.status, 'failed')
  assert.match(refused.diagnostic ?? '', /Candidate file hash mismatch/)
  assert.equal(await readFile(join(ctx.projectRoot, 'app.js'), 'utf8'), 'original\n')

  const backupRoot = join(ctx.storeRoot, 'nonexistent-backup')
  await rm(backupRoot, { recursive: true, force: true })
  const originalSha = (await hashFile(join(ctx.projectRoot, 'app.js'))).sha256
  const restored = await restoreFiles(ctx.projectRoot, backupRoot, [{
    path: 'app.js', kind: 'modified', oursSha256: originalSha, resultSha256: null,
  }])
  assert.equal(restored, false)
  assert.equal(await readFile(join(ctx.projectRoot, 'app.js'), 'utf8'), 'original\n')
})

test('files: apply compares original hashes, backups, restores on verify failure, refuses external edits', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-files-ap-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  await write(ctx.projectRoot, 'stay.js', 'stay\n')
  const prepared = await ctx.ws.prepareRun({
    runId: 'run-ap',
    kind: 'files',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
  })
  await write(prepared.workspacePath, 'app.js', 'from-worker\n')
  await write(prepared.workspacePath, 'extra.js', 'new\n')
  await ctx.ws.freezeDelivery({ runId: 'run-ap', deliveryId: 'del-ap', worker: stopped })
  const ready = await ctx.ws.integrate({
    applicationId: 'app-ap',
    deliveryId: 'del-ap',
    projectRoot: ctx.projectRoot,
    targetBranch: null,
    verificationCommand: null,
  })
  assert.equal(ready.status, 'ready')

  await write(ctx.projectRoot, 'app.js', 'external\n')
  const blocked = await ctx.ws.apply({
    applicationId: 'app-ap',
    expectedTarget: ready.expectedTarget,
    verificationCommand: null,
  })
  assert.equal(blocked.status, 'failed')
  assert.match(blocked.diagnostic ?? '', /external changes/)
  assert.equal(await readFile(join(ctx.projectRoot, 'app.js'), 'utf8'), 'external\n')

  await write(ctx.projectRoot, 'app.js', 'base\n')
  const sticky = await ctx.ws.apply({ applicationId: 'app-ap', expectedTarget: ready.expectedTarget,
    verificationCommand: null })
  assert.equal(sticky.status, 'failed')
  const refreshed = await ctx.ws.integrate({ applicationId: 'app-ap-refreshed', deliveryId: 'del-ap',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(refreshed.status, 'ready')
  const applied = await ctx.ws.apply({
    applicationId: 'app-ap-refreshed',
    expectedTarget: refreshed.expectedTarget,
    verificationCommand: null,
  })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'app.js'), 'utf8'), 'from-worker\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'extra.js'), 'utf8'), 'new\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'stay.js'), 'utf8'), 'stay\n')

  const ctx3 = await makeWorkspace('lachesis-files-rb-')
  t.after(ctx3.cleanup)
  await write(ctx3.projectRoot, 'app.js', 'base\n')
  const p3 = await ctx3.ws.prepareRun({
    runId: 'run-rb',
    kind: 'files',
    projectRoot: ctx3.projectRoot,
    targetBranch: null,
  })
  await write(p3.workspacePath, 'app.js', 'BAD\n')
  await ctx3.ws.freezeDelivery({ runId: 'run-rb', deliveryId: 'del-rb', worker: stopped })
  const integrated = await ctx3.ws.integrate({
    applicationId: 'app-rb',
    deliveryId: 'del-rb',
    projectRoot: ctx3.projectRoot,
    targetBranch: null,
    verificationCommand: null,
  })
  const rolled = await ctx3.ws.apply({
    applicationId: 'app-rb',
    expectedTarget: integrated.expectedTarget,
    verificationCommand: verifyNotContaining('app.js', 'BAD'),
  })
  assert.equal(rolled.status, 'failed')
  assert.equal(await readFile(join(ctx3.projectRoot, 'app.js'), 'utf8'), 'base\n')
  const missingVerifier = await ctx3.ws.apply({
    applicationId: 'app-rb',
    expectedTarget: integrated.expectedTarget,
    verificationCommand: ['lachesis-nonexistent-verifier-9f4b'],
  })
  assert.equal(missingVerifier.status, 'failed')
  assert.ok(missingVerifier.diagnostic && missingVerifier.diagnostic.length > 0)
  assert.ok(missingVerifier.evidence.some((item) => item.kind === 'verification' && item.outcome === 'failed'))
  assert.equal(await readFile(join(ctx3.projectRoot, 'app.js'), 'utf8'), 'base\n')
})
