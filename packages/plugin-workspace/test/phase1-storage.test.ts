import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import type { StorageReservation, StorageReservationBackend } from '@lachesis/contracts'
import { Git } from '../src/git.ts'
import { manifestSha256, sha256Bytes } from '../src/hash.ts'
import { MemoryReservationBackend, WorkspaceError, assertSameDevice, futureReservationBytes, isInside } from '../src/index.ts'
import { assertSameDriveOrUnc } from '../src/ledger.ts'
import { snapshotTree } from '../src/snapshot.ts'
import type { FileChange } from '../src/types.ts'
import { commitAll, initGit, makeWorkspace, stopped, write } from './helpers.ts'

test('production managed root includes database and home state without double-counting execution', async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-managed-root-')
  t.after(ctx.cleanup)
  const root = dirname(ctx.storeRoot)
  const before = await ctx.ws.ledger.observe()
  await write(root, 'domain.sqlite', 'x'.repeat(8192))
  await write(root, 'run-homes/probe/state.json', '{}')
  ctx.ws.ledger.setManagedRoot(root)
  const after = await ctx.ws.ledger.observe()
  assert(after.managedBytes >= before.managedBytes + 8192)
  assert.equal(after.managedBytes, await ctx.ws.ledger.measureDirectory(root))
  assert.throws(() => ctx.ws.ledger.setManagedRoot(ctx.storeRoot), /must contain/)
})

test('files: private copies share one baseline and survive cleanup', { timeout: 90_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-files-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'base\n')
  await write(ctx.projectRoot, 'build.ts', 'export const n = 1\n')
  await write(ctx.projectRoot, 'notes/build.txt', 'keep\n')
  await write(ctx.projectRoot, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  await write(ctx.projectRoot, 'dist/bundle.js', 'bundled\n')

  const a = await ctx.ws.prepareRun({ runId: 'run-a', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  const b = await ctx.ws.prepareRun({ runId: 'run-b', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  assert.equal(ctx.ws.runWorkspacePath('run-a'), a.workspacePath)
  assert.equal(a.tmpPath, join(a.executionPath!, 'tmp'))
  const beforeTemp = await ctx.ws.ledger.observe()
  await write(a.tmpPath!, 'dsh-private/probe.bin', 't'.repeat(8192))
  const afterTemp = await ctx.ws.ledger.observe()
  assert.ok(afterTemp.runBytes['run-a']! >= beforeTemp.runBytes['run-a']! + 8192)
  assert.equal(a.baselineId, b.baselineId)
  assert.equal(a.baseRef, b.baseRef)
  assert.equal((await readdir(join(ctx.storeRoot, 'baselines'))).length, 1)
  assert.equal(isInside(ctx.storeRoot, a.executionPath ?? ''), false)
  assert.notEqual(a.workspacePath, b.workspacePath)
  const [projectStat, aStat, bStat] = await Promise.all([
    stat(join(ctx.projectRoot, 'app.js'), { bigint: true }),
    stat(join(a.workspacePath, 'app.js'), { bigint: true }),
    stat(join(b.workspacePath, 'app.js'), { bigint: true }),
  ])
  assert.equal(aStat.nlink, 1n)
  assert.notEqual(aStat.ino, bStat.ino)
  assert.notEqual(aStat.ino, projectStat.ino)
  await access(join(ctx.storeRoot, 'runs', 'run-a', 'control.json'))
  await assert.rejects(access(join(a.executionPath ?? '', 'control.json')))
  await assert.rejects(() => ctx.ws.readBaselineBytes('run-a', 'node_modules/pkg/index.js'),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'not_found')

  await write(a.workspacePath, 'app.js', 'changed\n')
  await write(a.workspacePath, 'build.ts', 'export const n = 2\n')
  await write(a.workspacePath, 'node_modules/evil.js', 'nope\n')
  await write(a.workspacePath, 'dist/extra.js', 'nope\n')
  await write(a.workspacePath, 'build/out.js', 'nope\n')
  const { rm } = await import('node:fs/promises')
  await rm(join(a.workspacePath, 'notes/build.txt'))
  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-a', deliveryId: 'del-a', worker: stopped })
  const kinds = Object.fromEntries(frozen.files.map((file) => [file.path, file.kind]))
  assert.equal(kinds['app.js'], 'modified')
  assert.equal(kinds['build.ts'], 'modified')
  assert.equal(kinds['notes/build.txt'], 'deleted')
  assert.equal(kinds['node_modules/evil.js'], undefined)
  assert.equal(kinds['dist/extra.js'], undefined)
  assert.equal(kinds['build/out.js'], undefined)
  assert.ok(frozen.filtered.some((item) => item.path === 'node_modules' && item.reason === 'ignored'))
  assert.ok(frozen.filtered.some((item) => item.path === 'dist' && item.reason === 'ignored'))
  assert.ok(frozen.filtered.some((item) => item.path === 'build' && item.reason === 'ignored'))
  assert.equal(frozen.durability === 'file-sync' || frozen.durability === 'directory-sync', true)
  await access(a.workspacePath)
  await ctx.ws.disposeRun('run-a')
  await assert.rejects(access(a.workspacePath))
  await assert.rejects(access(a.tmpPath!))
  assert.equal(Buffer.from((await ctx.ws.readDeliveryFile('del-a', 'build.ts')).bytes).toString('utf8'), 'export const n = 2\n')

  const integrated = await ctx.ws.integrate({ applicationId: 'app-a', deliveryId: 'del-a',
    projectRoot: ctx.projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({ applicationId: 'app-a', expectedTarget: integrated.expectedTarget, verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'build.ts'), 'utf8'), 'export const n = 2\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'dist/bundle.js'), 'utf8'), 'bundled\n')
  await assert.rejects(access(join(ctx.projectRoot, 'notes/build.txt')))

  const rework = await ctx.ws.prepareRun({ runId: 'run-rework', kind: 'files', projectRoot: ctx.projectRoot,
    targetBranch: null, seedDeliveryId: 'del-a' })
  assert.equal(rework.baselineId, a.baselineId)
  assert.equal(await readFile(join(rework.workspacePath, 'build.ts'), 'utf8'), 'export const n = 2\n')
  await assert.rejects(access(join(rework.workspacePath, 'notes/build.txt')))
  assert.equal(await ctx.ws.inputDigest('run-rework'), await snapshotTree(rework.workspacePath))

  const blobPath = ctx.ws.blobPath(frozen.files.find((file) => file.path === 'build.ts')!.sha256!)
  await writeFile(blobPath, 'corrupt')
  await assert.rejects(() => ctx.ws.readDeliveryFile('del-a', 'build.ts'),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'store_corrupt')
})

test('git: service metadata stays private and rework works after cleanup', { timeout: 120_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-git-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, '.gitignore', '*.log\n')
  await write(ctx.projectRoot, 'app.js', 'base\n')
  const base = await commitAll(git, 'init')
  const configBefore = await git.text(['config', '--local', '--list'])
  const refsBefore = await git.text(['show-ref'])

  const prepared = await ctx.ws.prepareRun({ runId: 'run-git', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main' })
  assert.equal(prepared.baseRef, base)
  assert.equal(isInside(ctx.storeRoot, prepared.workspacePath), false)
  await assert.rejects(access(join(prepared.workspacePath, '.git')))
  const listed = await git.text(['worktree', 'list'])
  assert.equal(listed.includes(prepared.workspacePath), false)
  await write(prepared.workspacePath, '.gitignore', '# worker removed the rule\n')
  await write(prepared.workspacePath, 'noise.log', 'ignored\n')
  await write(prepared.workspacePath, '.git/config', '[remote "origin"]\n\turl = file:///tmp/not-the-operator\n')
  await write(prepared.workspacePath, 'real.js', 'real\n')
  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-git', deliveryId: 'del-git', worker: stopped })
  assert.ok(frozen.files.some((file) => file.path === '.gitignore' && file.kind === 'modified'))
  assert.ok(frozen.files.some((file) => file.path === 'real.js' && file.kind === 'added'))
  assert.equal(frozen.files.some((file) => file.path === 'noise.log' || file.path === '.git' || file.path.startsWith('.git/')), false)
  assert.ok(frozen.filtered.some((item) => item.path === 'noise.log' && item.reason === 'ignored'))
  assert.equal(await git.text(['config', '--local', '--list']), configBefore)
  assert.equal(await git.text(['show-ref']), refsBefore)
  assert.notEqual((await git.run(['cat-file', '-e', `${frozen.gitCommit}^{commit}`], { allowFailure: true })).code, 0)
  const service = new Git('git', ctx.ws.serviceGitDir(ctx.projectRoot))
  assert.equal((await service.run(['cat-file', '-e', `${frozen.gitCommit}^{commit}`])).code, 0)
  await assert.rejects(access(join(ctx.ws.serviceGitDir(ctx.projectRoot), 'objects', 'info', 'alternates')))
  const serviceConfig = await service.text(['config', '--local', '--list'])
  assert.doesNotMatch(serviceConfig, /credential\.helper|remote\./)
  await access(prepared.workspacePath)
  await ctx.ws.disposeRun('run-git')
  await assert.rejects(access(prepared.workspacePath))

  const rework = await ctx.ws.prepareRun({ runId: 'run-rework', kind: 'git', projectRoot: ctx.projectRoot,
    targetBranch: 'main', seedDeliveryId: 'del-git' })
  assert.equal(rework.baseRef, frozen.gitCommit)
  assert.equal(await readFile(join(rework.workspacePath, 'real.js'), 'utf8'), 'real\n')
  const integrated = await ctx.ws.integrate({ applicationId: 'app-git', deliveryId: 'del-git',
    projectRoot: ctx.projectRoot, targetBranch: 'main', verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const meta = JSON.parse(await readFile(join(ctx.storeRoot, 'integrations', 'app-git', 'meta.json'), 'utf8')) as { linkedWorktree?: boolean }
  assert.equal(meta.linkedWorktree, false)
  assert.equal(await git.text(['worktree', 'list']), listed)
  assert.equal(await git.text(['config', '--local', '--list']), configBefore)
  const applied = await ctx.ws.apply({ applicationId: 'app-git', expectedTarget: integrated.expectedTarget, verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'real.js'), 'utf8'), 'real\n')
  assert.equal(await git.text(['config', '--local', '--list']), configBefore)
  assert.notEqual((await git.run(['rev-parse', '--verify', 'refs/lachesis/deliveries/del-git'], { allowFailure: true })).code, 0)
  assert.equal((await git.run(['cat-file', '-e', `${frozen.gitCommit}^{commit}`])).code, 0)
})

test('storage budget fails closed and preserves an unconfirmed run', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-budget-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'keep\n')
  assert.throws(() => ctx.ws.setStoragePolicy({ minFreeBytes: -1 }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  ctx.ws.setStoragePolicy({ maxManagedBytes: 1 })
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-denied', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-denied')))
  await assert.rejects(access(join(ctx.storeRoot, 'queue')))
  assert.equal((await ctx.ws.storageStatus()).activeReservations, 0)
  ctx.ws.setStoragePolicy({ maxManagedBytes: 1, defaultRunReserveBytes: 2 })
  const denied = await ctx.ws.storageStatus()
  assert.equal(denied.canDispatch, false)
  assert.match(denied.diagnostic ?? '', /disk_capacity/)

  ctx.ws.setStoragePolicy({ maxManagedBytes: null, defaultRunReserveBytes: 0 })
  const prepared = await ctx.ws.prepareRun({ runId: 'run-live', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await assert.rejects(() => ctx.ws.freezeDelivery({ runId: 'run-live', deliveryId: 'del-live', worker: {} }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'worker_unproven')
  await access(prepared.workspacePath)
  assert.ok((await ctx.ws.storageStatus()).activeReservations >= 1)

  ctx.ws.setStoragePolicy({ maxManagedBytes: 1 })
  await assert.rejects(() => ctx.ws.saveCheckpoint({ runId: 'run-live', checkpointId: 'ck-denied', worker: stopped }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  await assert.rejects(access(join(ctx.storeRoot, 'checkpoints', 'ck-denied')))
  await access(prepared.workspacePath)

  ctx.ws.setStoragePolicy({ maxManagedBytes: null, executionRetentionHours: 0, checkpointRetentionDays: 0 })
  await write(prepared.workspacePath, 'app.js', 'held\n')
  await ctx.ws.saveCheckpoint({ runId: 'run-live', checkpointId: 'ck-kept', worker: stopped })
  await access(prepared.workspacePath)
  const held = await ctx.ws.freezeDelivery({ runId: 'run-live', deliveryId: 'del-held', worker: stopped })
  assert.equal(held.files.some((file) => file.path === 'app.js'), true)
  await access(prepared.workspacePath)
  const published = (await ctx.ws.ledger.listReservations()).find((row) => row.runId === 'run-live')
  assert.equal(published?.artifactReady, true)
  assert.equal(published?.published, false)
  assert.ok((await ctx.ws.storageStatus()).activeReservations >= 1)
  await ctx.ws.storageStatus()
  await access(prepared.workspacePath)
  await access(join(ctx.storeRoot, 'checkpoints', 'ck-kept'))
  await access(join(ctx.storeRoot, 'deliveries', 'del-held'))
  await ctx.ws.disposeRun('run-live')
  await assert.rejects(access(prepared.workspacePath))
  assert.equal((await ctx.ws.storageStatus()).activeReservations, 0)
  await access(join(ctx.storeRoot, 'checkpoints', 'ck-kept'))
  await access(join(ctx.storeRoot, 'deliveries', 'del-held'))
})

test('dispose releases a reservation and a failing authority fails closed', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-owner-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  await ctx.ws.prepareRun({ runId: 'run-probe', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  assert.ok((await ctx.ws.storageStatus()).activeReservations >= 1)
  await assert.rejects(access(join(ctx.storeRoot, 'storage', 'owner.json')))
  await assert.rejects(access(join(ctx.storeRoot, 'storage', 'ledger.json')))
  await ctx.ws.disposeRun('run-probe')
  assert.equal((await ctx.ws.storageStatus()).activeReservations, 0)
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-probe')))

  const failing: StorageReservationBackend = {
    list() { throw new Error('domain reservation store is unavailable') },
    acquire() { throw new Error('domain reservation store is unavailable') },
    materialized() { throw new Error('domain reservation store is unavailable') },
    artifactReady() { throw new Error('domain reservation store is unavailable') },
    assertCleanupAllowed() { throw new Error('domain reservation store is unavailable') },
    release() { throw new Error('domain reservation store is unavailable') },
  }
  ctx.ws.configureStorageBackend(failing)
  const blocked = await ctx.ws.storageStatus()
  assert.equal(blocked.canDispatch, false)
  assert.match(blocked.diagnostic ?? '', /storage_unavailable/)
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-after', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'storage_unavailable')
  await assert.rejects(access(join(ctx.storeRoot, 'storage', 'owner.json')))
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-after')))
})

test('legacy directory baselines stay readable and still rework', { timeout: 90_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-legacy-')
  t.after(ctx.cleanup)
  const projectRoot = resolve(ctx.projectRoot)
  const baseline = join(ctx.storeRoot, 'runs', 'legacy-run', 'baseline')
  await write(baseline, 'app.txt', 'original\n')
  await write(projectRoot, 'app.txt', 'original\n')
  const digest = await snapshotTree(baseline)
  const bytes = Buffer.from('candidate\n')
  const sha = sha256Bytes(bytes)
  const blob = ctx.ws.blobPath(sha)
  await mkdir(dirname(blob), { recursive: true })
  await writeFile(blob, bytes)
  const files: FileChange[] = [{ path: 'app.txt', kind: 'modified', size: bytes.length, sha256: sha, binary: false }]
  const run = {
    runId: 'legacy-run',
    kind: 'files',
    projectRoot,
    workspacePath: join(ctx.storeRoot, 'runs', 'legacy-run', 'work'),
    baselinePath: baseline,
    baseRef: `files:${digest}`,
    originBaseRef: null,
    targetBranch: null,
    createdAt: new Date().toISOString(),
  }
  const manifest = {
    deliveryId: 'del-legacy-hist',
    runId: 'legacy-run',
    kind: 'files',
    baseRef: run.baseRef,
    originBaseRef: null,
    files,
    filtered: [],
    manifestSha256: manifestSha256(files),
    gitCommit: null,
    createdAt: run.createdAt,
  }
  const deliveryDir = join(ctx.storeRoot, 'deliveries', 'del-legacy-hist')
  await mkdir(deliveryDir, { recursive: true })
  await writeFile(join(deliveryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(deliveryDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  await mkdir(join(ctx.storeRoot, 'runs', 'legacy-run'), { recursive: true })
  await writeFile(join(ctx.storeRoot, 'runs', 'legacy-run', 'meta.json'), `${JSON.stringify(run, null, 2)}\n`)

  const rework = await ctx.ws.prepareRun({ runId: 'run-from-legacy', kind: 'files', projectRoot, targetBranch: null,
    seedDeliveryId: 'del-legacy-hist' })
  assert.equal(await readFile(join(rework.workspacePath, 'app.txt'), 'utf8'), 'candidate\n')
  const integrated = await ctx.ws.integrate({ applicationId: 'app-legacy-hist', deliveryId: 'del-legacy-hist',
    projectRoot, targetBranch: null, verificationCommand: null })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({ applicationId: 'app-legacy-hist', expectedTarget: integrated.expectedTarget, verificationCommand: null })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(projectRoot, 'app.txt'), 'utf8'), 'candidate\n')
  assert.equal(await readFile(join(baseline, 'app.txt'), 'utf8'), 'original\n')

  await write(baseline, 'app.txt', 'tampered\n')
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-tampered-legacy', kind: 'files', projectRoot, targetBranch: null,
    seedDeliveryId: 'del-legacy-hist' }), /baseline no longer matches/)
  await access(join(baseline, 'app.txt'))
  assert.equal(Buffer.from((await ctx.ws.readDeliveryFile('del-legacy-hist', 'app.txt')).bytes).toString('utf8'), 'candidate\n')
})

test('future reservation is unused room after growth and is zero once artifact-ready', () => {
  const row: StorageReservation = {
    runId: 'run-formula',
    generation: 1,
    bytes: 5_000,
    remainingBytes: 400,
    executionBaseBytes: 500,
    createdAt: '2026-10-04T00:00:00.000Z',
    artifactReady: false,
    published: false,
  }
  assert.equal(futureReservationBytes(row, 500), 400)
  assert.equal(futureReservationBytes(row, 700), 200)
  assert.equal(futureReservationBytes(row, 5_000), 0)
  assert.equal(futureReservationBytes({ ...row, artifactReady: true }, 500), 0)
  assert.throws(() => assertSameDevice(1, 2), (error: unknown) => error instanceof WorkspaceError && error.code === 'storage_unavailable')
  assertSameDevice(4, 4)
})

test('held backend is reused and free capacity is not charged twice', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-account-')
  t.after(ctx.cleanup)
  const payload = Buffer.alloc(2_000_000, 7)
  await write(ctx.projectRoot, 'blob.bin', payload)
  const estimate = await ctx.ws.estimateRunReservation({
    kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null,
  })
  assert.equal(estimate.sourceRef, null)
  assert.ok(estimate.requiredBytes >= payload.length)
  await assert.rejects(access(join(ctx.storeRoot, 'baselines')))
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-held')))
  assert.equal((await ctx.ws.storageStatus()).activeReservations, 0)

  const authority = new MemoryReservationBackend()
  const observed = await ctx.ws.ledger.observe()
  const held = authority.acquire('run-held', estimate.requiredBytes, observed)
  assert.equal(held.generation, 1)
  ctx.ws.configureStorageBackend(authority)
  ctx.ws.setStoragePolicy({ maxManagedBytes: estimate.requiredBytes + 2_000_000, defaultRunReserveBytes: 0, artifactPublishReserveBytes: 0 })
  const prepared = await ctx.ws.prepareRun({ runId: 'run-held', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  const row = authority.list().find((item) => item.runId === 'run-held')
  assert.ok(row)
  assert.equal(row?.bytes, estimate.requiredBytes)
  assert.equal(row?.generation, 1)
  assert.ok((row?.remainingBytes ?? 0) < (row?.bytes ?? 0))
  assert.ok((row?.executionBaseBytes ?? 0) > 0)
  const status = await ctx.ws.storageStatus()
  assert.equal(status.canDispatch, true)
  assert.ok(status.reservedBytes <= (row?.remainingBytes ?? 0))
  assert.ok(status.managedBytes >= (row?.executionBaseBytes ?? 0))
  await assert.rejects(access(join(ctx.storeRoot, 'storage', 'owner.json')))
  await assert.rejects(access(join(ctx.storeRoot, 'storage', 'ledger.json')))

  await write(prepared.homePath ?? '', 'growth.bin', Buffer.alloc(300_000, 3))
  const grown = await ctx.ws.storageStatus()
  assert.ok(grown.managedBytes > status.managedBytes)
  assert.ok(grown.reservedBytes < status.reservedBytes)
  const seen = await ctx.ws.ledger.observe()
  assert.ok((seen.runBytes['run-held'] ?? 0) > (row?.executionBaseBytes ?? 0))

  authority.acquire('run-deny', 1, observed)
  ctx.ws.setStoragePolicy({ maxManagedBytes: 1 })
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-deny', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  assert.equal(authority.list().find((item) => item.runId === 'run-deny')?.bytes, 1)
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-deny')))
})

test('cleanup failure keeps the reservation', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-cleanup-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  const prepared = await ctx.ws.prepareRun({ runId: 'run-lock', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: prepared.executionPath,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  })
  t.after(() => { child.kill('SIGTERM') })
  await new Promise((resolvePromise) => child.once('spawn', resolvePromise))
  await assert.rejects(() => ctx.ws.disposeRun('run-lock'),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'storage_unavailable')
  assert.ok((await ctx.ws.ledger.listReservations()).some((row) => row.runId === 'run-lock'))
  await access(prepared.workspacePath)
  child.kill('SIGTERM')
  await new Promise((resolvePromise) => child.once('exit', resolvePromise))
  await ctx.ws.disposeRun('run-lock')
  assert.equal((await ctx.ws.ledger.listReservations()).some((row) => row.runId === 'run-lock'), false)
  await assert.rejects(access(prepared.workspacePath))
})

test('blob publication does not expose partial bytes and rejects a forgery', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-blob-')
  t.after(ctx.cleanup)
  const payload = Buffer.alloc(4 * 1024 * 1024, 9)
  const sha = sha256Bytes(payload)
  let corrupt = 0
  const writer = ctx.ws.store.putBlob(payload)
  const readers = Array.from({ length: 6 }, async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const got = await ctx.ws.store.getBlob(sha)
        if (sha256Bytes(got) !== sha || got.length !== payload.length) corrupt += 1
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'not_found') continue
        if (error instanceof WorkspaceError && error.code === 'store_corrupt') corrupt += 1
        else throw error
      }
    }
  })
  await Promise.all([writer, ...readers])
  assert.equal(corrupt, 0)
  const reused = await Promise.all([ctx.ws.store.putBlob(payload), ctx.ws.store.putBlob(payload)])
  assert.deepEqual(reused, [sha, sha])
  await writeFile(ctx.ws.blobPath(sha), Buffer.from('forged'))
  await assert.rejects(() => ctx.ws.store.getBlob(sha),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'store_corrupt')

  const fresh = Buffer.from('distinct-bytes')
  const freshSha = sha256Bytes(fresh)
  const dest = ctx.ws.blobPath(freshSha)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from('planted'))
  await assert.rejects(() => ctx.ws.store.putBlob(fresh),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'store_corrupt')
  assert.equal(await readFile(dest, 'utf8'), 'planted')
})

test('pinned git source omits secrets and does not delete them from the target', { timeout: 120_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-pin-')
  t.after(ctx.cleanup)
  const git = await initGit(ctx.projectRoot)
  await write(ctx.projectRoot, '.gitignore', 'node_modules/\n')
  await write(ctx.projectRoot, 'app.js', 'v1\n')
  await write(ctx.projectRoot, '.env', 'SECRET=1\n')
  await write(ctx.projectRoot, 'secrets/id_ed25519', 'PRIVATE\n')
  const first = await commitAll(git, 'init')
  await write(ctx.projectRoot, 'other.js', 'later\n')
  const tip = await commitAll(git, 'later')
  await write(ctx.projectRoot, 'node_modules/pkg/index.js', 'ignored\n')
  const configBefore = await git.text(['config', '--local', '--list'])
  const refsBefore = await git.text(['show-ref'])

  const estimate = await ctx.ws.estimateRunReservation({
    kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main', pinnedBaseRef: first,
  })
  assert.equal(estimate.sourceRef, first)
  assert.notEqual(estimate.sourceRef, tip)
  assert.ok(estimate.requiredBytes > 0)
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-pin')))
  await assert.rejects(access(ctx.ws.serviceGitDir(ctx.projectRoot)))

  const prepared = await ctx.ws.prepareRun({
    runId: 'run-pin', kind: 'git', projectRoot: ctx.projectRoot, targetBranch: 'main', pinnedBaseRef: first,
  })
  assert.equal(prepared.baseRef, first)
  assert.equal(prepared.targetBranch, 'main')
  assert.equal(await readFile(join(prepared.workspacePath, 'app.js'), 'utf8'), 'v1\n')
  await assert.rejects(access(join(prepared.workspacePath, 'other.js')))
  await assert.rejects(access(join(prepared.workspacePath, '.env')))
  await assert.rejects(access(join(prepared.workspacePath, 'secrets', 'id_ed25519')))
  await assert.rejects(access(join(prepared.workspacePath, 'node_modules')))
  assert.equal(await ctx.ws.inputDigest('run-pin'), await snapshotTree(prepared.workspacePath))
  assert.equal(await git.text(['config', '--local', '--list']), configBefore)
  assert.equal(await git.text(['show-ref']), refsBefore)

  await write(prepared.workspacePath, 'app.js', 'v3\n')
  const frozen = await ctx.ws.freezeDelivery({ runId: 'run-pin', deliveryId: 'del-pin', worker: stopped })
  const kinds = Object.fromEntries(frozen.files.map((file) => [file.path, file.kind]))
  assert.equal(kinds['app.js'], 'modified')
  assert.equal(kinds['.env'], undefined)
  assert.equal(kinds['secrets/id_ed25519'], undefined)
  assert.equal(kinds['node_modules/pkg/index.js'], undefined)
  assert.equal(frozen.files.some((file) => file.kind === 'deleted' && file.path.includes('.env')), false)
  await ctx.ws.disposeRun('run-pin')

  const integrated = await ctx.ws.integrate({
    applicationId: 'app-pin', deliveryId: 'del-pin', projectRoot: ctx.projectRoot, targetBranch: 'main', verificationCommand: null,
  })
  assert.equal(integrated.status, 'ready')
  const applied = await ctx.ws.apply({
    applicationId: 'app-pin', expectedTarget: integrated.expectedTarget, verificationCommand: null,
  })
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(ctx.projectRoot, 'app.js'), 'utf8'), 'v3\n')
  assert.equal(await readFile(join(ctx.projectRoot, '.env'), 'utf8'), 'SECRET=1\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'secrets', 'id_ed25519'), 'utf8'), 'PRIVATE\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'ignored\n')
  assert.equal(await readFile(join(ctx.projectRoot, 'other.js'), 'utf8'), 'later\n')
  assert.notEqual((await git.run(['rev-parse', '--verify', 'refs/lachesis/deliveries/del-pin'], { allowFailure: true })).code, 0)
  assert.doesNotMatch(await git.text(['config', '--local', '--list']), /credential\.helper/)
  const service = new Git('git', ctx.ws.serviceGitDir(ctx.projectRoot))
  assert.equal((await service.run(['cat-file', '-e', `${first}^{commit}`])).code, 0)
  await assert.rejects(access(join(ctx.ws.serviceGitDir(ctx.projectRoot), 'objects', 'info', 'alternates')))
})

test('drive or UNC split is rejected before the device check', () => {
  assertSameDriveOrUnc('C:\\store\\artifacts', 'C:\\data\\execution')
  assertSameDriveOrUnc('\\\\files\\share\\store', '\\\\files\\share\\execution')
  assert.throws(() => assertSameDriveOrUnc('C:\\store', 'D:\\execution'),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'storage_unavailable')
  assert.throws(() => assertSameDriveOrUnc('\\\\files\\share\\store', '\\\\files\\other\\execution'),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'storage_unavailable')
})

test('small file estimate includes allocation and a tight budget does not prepare', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-tiny-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'tiny.txt', 'x')
  const estimate = await ctx.ws.estimateRunReservation({ kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  assert.ok(estimate.requiredBytes > 8195)
  ctx.ws.setStoragePolicy({ maxManagedBytes: 8195, defaultRunReserveBytes: 0, artifactPublishReserveBytes: 0 })
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-tiny', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-tiny')))
  assert.equal((await ctx.ws.ledger.listReservations()).length, 0)
})

test('domain disk_capacity survives acquire and an underestimate rolls back', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-capacity-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'tiny.txt', 'x')
  const denying: StorageReservationBackend = {
    list: () => [],
    acquire() { throw Object.assign(new Error('domain budget'), { code: 'disk_capacity' }) },
    materialized() { /* unused */ },
    artifactReady() { /* unused */ },
    assertCleanupAllowed() { /* unused */ },
    release() { /* unused */ },
  }
  ctx.ws.configureStorageBackend(denying)
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-deny-code', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'disk_capacity'))
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-deny-code')))

  class Underestimate extends MemoryReservationBackend {
    override materialized(runId: string, remainingBytes: number, executionBaseBytes: number): void {
      super.materialized(runId, remainingBytes + 50_000_000, executionBaseBytes)
    }
  }
  const authority = new Underestimate()
  ctx.ws.configureStorageBackend(authority)
  ctx.ws.setStoragePolicy({ maxManagedBytes: null, defaultRunReserveBytes: 0, artifactPublishReserveBytes: 0 })
  const estimate = await ctx.ws.estimateRunReservation({ kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  const before = await ctx.ws.ledger.observe()
  ctx.ws.setStoragePolicy({ maxManagedBytes: before.managedBytes + estimate.requiredBytes, defaultRunReserveBytes: 0, artifactPublishReserveBytes: 0 })
  await assert.rejects(() => ctx.ws.prepareRun({ runId: 'run-under', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null }),
    (error: unknown) => error instanceof WorkspaceError && error.code === 'disk_capacity')
  await assert.rejects(access(join(ctx.ws.executionRoot, 'run-under')))
  await assert.rejects(access(join(ctx.storeRoot, 'runs', 'run-under')))
  assert.equal(authority.list().some((row) => row.runId === 'run-under'), false)
})

test('dispose asks the reservation authority before deleting execution', { timeout: 30_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-p1-dispose-')
  t.after(ctx.cleanup)
  await write(ctx.projectRoot, 'app.js', 'x\n')
  const authority = new MemoryReservationBackend()
  ctx.ws.configureStorageBackend(authority)
  const prepared = await ctx.ws.prepareRun({ runId: 'run-live', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  let checks = 0
  const blocking: StorageReservationBackend = {
    list: () => authority.list(),
    acquire: (runId, bytes, observation) => authority.acquire(runId, bytes, observation),
    materialized: (runId, remainingBytes, executionBaseBytes) => authority.materialized(runId, remainingBytes, executionBaseBytes),
    artifactReady: (runId) => authority.artifactReady(runId),
    assertCleanupAllowed() {
      checks += 1
      throw Object.assign(new Error('unconfirmed worker'), { code: 'conflict' })
    },
    release() { throw new Error('release must not run') },
  }
  ctx.ws.configureStorageBackend(blocking)
  await assert.rejects(() => ctx.ws.disposeRun('run-live'),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'conflict'))
  assert.equal(checks, 1)
  await access(prepared.workspacePath)
  assert.equal(authority.list().some((row) => row.runId === 'run-live'), true)
})
