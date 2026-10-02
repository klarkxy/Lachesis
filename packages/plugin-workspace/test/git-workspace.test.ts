import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { WorkspaceError } from '../src/index.ts'
import { commitAll, initGit, makeWorkspace, stopped, verifyNotContaining, write } from './helpers.ts'

test('git: two tickets get independent worktrees pinned to the same commit', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-par-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, '.gitignore', '*.log\n')
  await write(ctx.projectRoot, 'app.js', 'module.exports = 1\n')
  await write(ctx.projectRoot, 'shared.js', 'shared\n')
  const base = await commitAll(git, 'init')

  const a = await ctx.ws.prepareRun({ runId: 'run-a', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  const b = await ctx.ws.prepareRun({ runId: 'run-b', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  assert.equal(a.baseRef, base)
  assert.equal(b.baseRef, base)
  assert.notEqual(a.workspacePath, b.workspacePath)
  assert.equal(a.workspacePath.startsWith(ctx.storeRoot), true)

  await write(a.workspacePath, 'ticket-a.js', 'A\n')
  await write(b.workspacePath, 'ticket-b.js', 'B\n')
  await write(a.workspacePath, 'shared.js', 'from-a\n')

  const frozenA = await ctx.ws.freezeDelivery({ runId: 'run-a', deliveryId: 'del-a', worker: stopped })
  const frozenB = await ctx.ws.freezeDelivery({ runId: 'run-b', deliveryId: 'del-b', worker: stopped })
  assert.ok(frozenA.files.some((file) => file.path === 'ticket-a.js' && file.kind === 'added'))
  assert.ok(frozenB.files.some((file) => file.path === 'ticket-b.js' && file.kind === 'added'))
  assert.equal(frozenA.files.some((file) => file.path === 'ticket-b.js'), false)
  assert.ok(frozenA.gitCommit)
  assert.notEqual(frozenA.gitCommit, frozenB.gitCommit)
})

test('git: rework carries the prior delivery commit into a fresh Run', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-rework-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'base.txt', 'base\n')
  await commitAll(git, 'init')
  const first = await ctx.ws.prepareRun({ runId: 'run-first', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  await write(first.workspacePath, 'first.txt', 'first\n')
  const firstDelivery = await ctx.ws.freezeDelivery({ runId: 'run-first', deliveryId: 'del-first', worker: stopped })
  const second = await ctx.ws.prepareRun({ runId: 'run-second', kind: 'git', projectRoot: ctx.projectRoot,
    targetBranch: 'main', seedDeliveryId: 'del-first' })
  assert.equal(second.baseRef, firstDelivery.gitCommit)
  assert.equal(await readFile(join(second.workspacePath, 'first.txt'), 'utf8'), 'first\n')
  await write(second.workspacePath, 'second.txt', 'second\n')
  const secondDelivery = await ctx.ws.freezeDelivery({ runId: 'run-second', deliveryId: 'del-second', worker: stopped })
  assert.deepEqual(secondDelivery.files.map((file) => file.path).sort(), ['first.txt', 'second.txt'])
  const third = await ctx.ws.prepareRun({ runId: 'run-third', kind: 'git', projectRoot: ctx.projectRoot,
    targetBranch: 'main', seedDeliveryId: 'del-second' })
  assert.equal(third.baseRef, secondDelivery.gitCommit)
  const unchangedRework = await ctx.ws.freezeDelivery({ runId: 'run-third', deliveryId: 'del-third', worker: stopped })
  assert.deepEqual(unchangedRework.files.map((file) => file.path).sort(), ['first.txt', 'second.txt'])
  const integrated = await ctx.ws.integrate({ applicationId: 'app-second', deliveryId: 'del-second',
    projectRoot: ctx.projectRoot, targetBranch: 'main', verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({ applicationId: 'app-second', expectedTarget: integrated.expectedTarget,
    verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'first.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'second.txt'), 'utf8'), 'second\n')
})

test('git: rework can undo an inherited edit without retaining it in the delivery commit', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-revert-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.txt', 'ORIGINAL\n')
  await write(ctx.projectRoot, 'keep.txt', 'KEEP\n')
  await commitAll(git, 'init')
  const first = await ctx.ws.prepareRun({ runId: 'run-first', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  await write(first.workspacePath, 'app.txt', 'UNWANTED\n')
  await write(first.workspacePath, 'extra.txt', 'UNWANTED\n')
  await rm(join(first.workspacePath, 'keep.txt'))
  await ctx.ws.freezeDelivery({ runId: 'run-first', deliveryId: 'del-first', worker: stopped })
  const second = await ctx.ws.prepareRun({ runId: 'run-second', kind: 'git', projectRoot: ctx.projectRoot,
    targetBranch: 'main', seedDeliveryId: 'del-first' })
  await write(second.workspacePath, 'app.txt', 'ORIGINAL\n')
  await rm(join(second.workspacePath, 'extra.txt'))
  await write(second.workspacePath, 'keep.txt', 'KEEP\n')
  const undone = await ctx.ws.freezeDelivery({ runId: 'run-second', deliveryId: 'del-second', worker: stopped })
  assert.deepEqual(undone.files, [])
  assert.equal(await git.text(['show', `${undone.gitCommit}:app.txt`]), 'ORIGINAL')
  assert.equal(await git.text(['show', `${undone.gitCommit}:keep.txt`]), 'KEEP')
  assert.notEqual((await git.run(['cat-file', '-e', `${undone.gitCommit}:extra.txt`], { allowFailure: true })).code, 0)
  const integrated = await ctx.ws.integrate({ applicationId: 'app-reverted', deliveryId: 'del-second',
    projectRoot: ctx.projectRoot, targetBranch: 'main', verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({ applicationId: 'app-reverted', expectedTarget: integrated.expectedTarget,
    verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'app.txt'), 'utf8'), 'ORIGINAL\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'keep.txt'), 'utf8'), 'KEEP\n')
  await assert.rejects(readFile(join(ctx.projectRoot, 'extra.txt')))
})

test('git: freeze captures untracked, binary, deletes; drops ignored and secrets', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-frz-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, '.gitignore', '*.log\n')
  await write(ctx.projectRoot, 'app.js', 'keep\n')
  await write(ctx.projectRoot, 'gone.js', 'bye\n')
  await commitAll(git, 'init')

  const prepared = await ctx.ws.prepareRun({
    runId: 'run-1',
    kind: 'git',
    projectRoot: ctx.projectRoot,
    targetBranch: 'main',
  })
  await write(prepared.workspacePath, 'app.js', 'changed\n')
  await write(prepared.workspacePath, 'new.js', 'untracked\n')
  await write(prepared.workspacePath, 'noise.log', 'ignored\n')
  await write(prepared.workspacePath, '.env', 'SECRET=1\n')
  await write(prepared.workspacePath, 'blob.bin', Buffer.from([0, 1, 2, 3, 0]))
  const { rm } = await import('node:fs/promises')
  await rm(join(prepared.workspacePath, 'gone.js'))

  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-1', deliveryId: 'del-1', worker: stopped })
  const kinds = Object.fromEntries(frozen.files.map((file) => [file.path, file]))
  assert.equal(kinds['app.js']?.kind, 'modified')
  assert.equal(kinds['new.js']?.kind, 'added')
  assert.equal(kinds['gone.js']?.kind, 'deleted')
  assert.equal(kinds['blob.bin']?.binary, true)
  assert.equal(kinds['blob.bin']?.kind, 'added')
  assert.equal(kinds['noise.log'], undefined)
  assert.equal(kinds['.env'], undefined)
  assert.ok(frozen.filtered.some((item) => item.path === 'noise.log' && item.reason === 'ignored'))
  assert.ok(frozen.filtered.some((item) => item.path === '.env' && item.reason === 'sensitive'))
  const bytes = await ctx.ws.readDeliveryFile('del-1', 'new.js')
  assert.equal(Buffer.from(bytes.bytes).toString('utf8'), 'untracked\n')
})

test('git: integrate three-way merge, conflict keeps candidate, clean merge still verifies', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-int-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  await write(ctx.projectRoot, 'ok.js', 'ok\n')
  await commitAll(git, 'init')

  const prepared = await ctx.ws.prepareRun({
    runId: 'run-c',
    kind: 'git',
    projectRoot: ctx.projectRoot,
    targetBranch: 'main',
  })
  await write(prepared.workspacePath, 'app.js', 'from-worker\nBAD\n')
  await ctx.ws.freezeDelivery({ runId: 'run-c', deliveryId: 'del-c', worker: stopped })

  await write(ctx.projectRoot, 'app.js', 'from-target\n')
  await commitAll(git, 'target moved')

  const conflicted = await ctx.ws.integrate({
    applicationId: 'app-conflict',
    deliveryId: 'del-c',
    projectRoot: ctx.projectRoot,
    targetBranch: 'main',
    verificationCommand: verifyNotContaining('app.js', 'BAD'),
  })
  assert.equal(conflicted.status, 'conflict')
  assert.ok(conflicted.conflictPaths.includes('app.js'))
  assert.equal(conflicted.resultTarget, null)
  const { access } = await import('node:fs/promises')
  await access(conflicted.integrationPath)

  const ctx2 = await makeWorkspace('lachesis-git-ver-')
  t.after(ctx2.cleanup)
  const git2 = await initGit(ctx2.projectRoot)
  await write(ctx2.projectRoot, 'app.js', 'base\n')
  await commitAll(git2, 'init')
  const prepared2 = await ctx2.ws.prepareRun({
    runId: 'run-v',
    kind: 'git',
    projectRoot: ctx2.projectRoot,
    targetBranch: 'main',
  })
  await write(prepared2.workspacePath, 'app.js', 'merged-clean\nBAD\n')
  await ctx2.ws.freezeDelivery({ runId: 'run-v', deliveryId: 'del-v', worker: stopped })
  const failedVerify = await ctx2.ws.integrate({
    applicationId: 'app-verify',
    deliveryId: 'del-v',
    projectRoot: ctx2.projectRoot,
    targetBranch: 'main',
    verificationCommand: verifyNotContaining('app.js', 'BAD'),
  })
  assert.equal(failedVerify.status, 'failed')
  assert.equal(failedVerify.conflictPaths.length, 0)
  assert.ok(failedVerify.evidence.some((item) => item.kind === 'verification' && item.outcome === 'failed'))
})

test('git: apply checks target commit and clean tree, rolls back on verify failure', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-ap-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  const t0 = await commitAll(git, 'init')

  const prepared = await ctx.ws.prepareRun({
    runId: 'run-ap',
    kind: 'git',
    projectRoot: ctx.projectRoot,
    targetBranch: 'main',
  })
  await write(prepared.workspacePath, 'extra.js', 'hello\n')
  await write(prepared.workspacePath, 'app.js', 'base\nworker\n')
  await ctx.ws.freezeDelivery({ runId: 'run-ap', deliveryId: 'del-ap', worker: stopped })

  const ready = await ctx.ws.integrate({
    applicationId: 'app-ap',
    deliveryId: 'del-ap',
    projectRoot: ctx.projectRoot,
    targetBranch: 'main',
    verificationCommand: verifyNotContaining('app.js', 'NEVER'),
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.expectedTarget, t0)
  const newCandidate = async (applicationId: string) => {
    const candidate = await ctx.ws.integrate({ applicationId, deliveryId: 'del-ap',
      projectRoot: ctx.projectRoot, targetBranch: 'main', verificationCommand: null })
    assert.equal(candidate.status, 'ready')
    return candidate
  }

  // A different branch at the identical commit must not receive the apply.
  await git.run(['checkout', '-b', 'other-branch'])
  const wrongBranch = await ctx.ws.apply({
    applicationId: 'app-ap', expectedTarget: ready.expectedTarget, verificationCommand: null,
  })
  assert.equal(wrongBranch.status, 'failed')
  assert.match(wrongBranch.diagnostic ?? '', /Target branch changed/)
  assert.equal(await git.text(['rev-parse', 'HEAD']), t0)
  await git.run(['checkout', 'main'])

  await newCandidate('app-stale')
  const stale = await ctx.ws.apply({
    applicationId: 'app-stale',
    expectedTarget: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    verificationCommand: null,
  })
  assert.equal(stale.status, 'failed')
  assert.match(stale.diagnostic ?? '', /expectedTarget mismatch/)

  const dirtyCandidate = await newCandidate('app-dirty')
  await write(ctx.projectRoot, 'dirt.txt', 'nope\n')
  const dirty = await ctx.ws.apply({
    applicationId: 'app-dirty',
    expectedTarget: dirtyCandidate.expectedTarget,
    verificationCommand: null,
  })
  assert.equal(dirty.status, 'failed')
  assert.match(dirty.diagnostic ?? '', /not clean/)
  const { rm } = await import('node:fs/promises')
  await rm(join(ctx.projectRoot, 'dirt.txt'))

  const movedCandidate = await newCandidate('app-moved')
  await write(ctx.projectRoot, 'app.js', 'moved-on-target\n')
  await commitAll(git, 'target changed')
  const moved = await ctx.ws.apply({
    applicationId: 'app-moved',
    expectedTarget: movedCandidate.expectedTarget,
    verificationCommand: null,
  })
  assert.equal(moved.status, 'failed')
  assert.match(moved.diagnostic ?? '', /is not expected target/)

  await git.run(['reset', '--hard', t0])
  const successCandidate = await newCandidate('app-success')
  const applied = await ctx.ws.apply({
    applicationId: 'app-success',
    expectedTarget: successCandidate.expectedTarget,
    verificationCommand: verifyNotContaining('app.js', 'NEVER'),
  })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'extra.js'), 'utf8'), 'hello\n')
  assert.ok(applied.rollbackRef)

  const ctx3 = await makeWorkspace('lachesis-git-rb-')
  t.after(ctx3.cleanup)
  const git3 = await initGit(ctx3.projectRoot)
  await write(ctx3.projectRoot, 'app.js', 'base\n')
  await commitAll(git3, 'init')
  const p3 = await ctx3.ws.prepareRun({
    runId: 'run-rb',
    kind: 'git',
    projectRoot: ctx3.projectRoot,
    targetBranch: 'main',
  })
  await write(p3.workspacePath, 'app.js', 'base\nBAD\n')
  await ctx3.ws.freezeDelivery({ runId: 'run-rb', deliveryId: 'del-rb', worker: stopped })
  const integrated = await ctx3.ws.integrate({
    applicationId: 'app-rb',
    deliveryId: 'del-rb',
    projectRoot: ctx3.projectRoot,
    targetBranch: 'main',
    verificationCommand: null,
  })
  assert.equal(integrated.status, 'ready')
  const rolled = await ctx3.ws.apply({
    applicationId: 'app-rb',
    expectedTarget: integrated.expectedTarget,
    verificationCommand: verifyNotContaining('app.js', 'BAD'),
  })
  assert.equal(rolled.status, 'failed')
  assert.equal(await readFile(join(ctx3.projectRoot, 'app.js'), 'utf8'), 'base\n')
})

test('git: repeated delivery ID cannot replace manifest or Git ref', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-immutable-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  const base = await commitAll(git, 'init')
  const run = await ctx.ws.prepareRun({ runId: 'run-immutable', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  await write(run.workspacePath, 'app.js', 'first\n')
  const first = await ctx.ws.freezeDelivery({ runId: 'run-immutable', deliveryId: 'del-immutable', worker: stopped })
  const ref = 'refs/lachesis/deliveries/del-immutable'
  assert.equal(await git.text(['rev-parse', ref]), first.gitCommit)
  await write(run.workspacePath, 'app.js', 'second\n')
  await assert.rejects(() => ctx.ws.freezeDelivery({ runId: 'run-immutable', deliveryId: 'del-immutable', worker: stopped }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'invalid_id')
  const manifest = JSON.parse(await readFile(join(ctx.storeRoot, 'deliveries', 'del-immutable', 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest, first)
  assert.equal(await git.text(['rev-parse', ref]), first.gitCommit)

  const orphanRef = 'refs/lachesis/deliveries/orphan-delivery'
  await git.run(['update-ref', orphanRef, base])
  await assert.rejects(() => ctx.ws.freezeDelivery({ runId: 'run-immutable', deliveryId: 'orphan-delivery', worker: stopped }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'git_failed')
  assert.equal(await git.text(['rev-parse', orphanRef]), base)
})

test('git: freeze without a stop proof is refused', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-git-stop-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  await commitAll(git, 'init')
  await ctx.ws.prepareRun({ runId: 'run-s', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  await assert.rejects(
    () => ctx.ws.freezeDelivery({ runId: 'run-s', deliveryId: 'del-s', worker: {} }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'worker_unproven',
  )
})
