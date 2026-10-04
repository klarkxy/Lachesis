import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { commitAll, initGit, makeWorkspace, stopped, write } from './helpers.ts'
import { controlPath } from '../src/prepare.ts'

for (const kind of ['files', 'git'] as const) {
  test(`review: ${kind} uses the immutable origin across cumulative rework`, { timeout: 60_000 }, async (t) => {
    const ctx = await makeWorkspace(`lachesis-review-${kind}-`)
    t.after(ctx.cleanup)
    await write(ctx.projectRoot, 'app.txt', 'original\n')
    await write(ctx.projectRoot, 'removed.txt', 'remove me\n')
    const git = kind === 'git' ? await initGit(ctx.projectRoot) : null
    if (git) await commitAll(git, 'baseline')
    const first = await ctx.ws.prepareRun({ runId: 'first', kind, projectRoot: ctx.projectRoot, targetBranch: null })
    await write(first.workspacePath, 'app.txt', 'first change\n')
    await ctx.ws.freezeDelivery({ runId: 'first', deliveryId: 'first-delivery', worker: stopped })
    const next = await ctx.ws.prepareRun({ runId: 'next', kind, projectRoot: ctx.projectRoot, targetBranch: null, seedDeliveryId: 'first-delivery' })
    await write(next.workspacePath, 'app.txt', 'final change\n')
    await write(next.workspacePath, 'added.txt', '<script>alert(1)</script>\n')
    await rm(join(next.workspacePath, 'removed.txt'))
    await ctx.ws.freezeDelivery({ runId: 'next', deliveryId: 'next-delivery', worker: stopped })
    await write(ctx.projectRoot, 'app.txt', 'unrelated current project edit\n')
    await write(next.workspacePath, 'app.txt', 'post-freeze edit\n')
    // Published review must survive mutable run metadata being removed/cleaned.
    await rm(controlPath(ctx.ws.store, next.runId))
    const modified = await ctx.ws.reviewDeliveryFile('next-delivery', 'app.txt')
    assert.deepEqual(modified, { path: 'app.txt', kind: 'modified', before: 'original\n', after: 'final change\n', binary: false, truncated: false, unavailableReason: null })
    const added = await ctx.ws.reviewDeliveryFile('next-delivery', 'added.txt')
    assert.equal(added.before, null)
    assert.equal(added.after, '<script>alert(1)</script>\n')
    const deleted = await ctx.ws.reviewDeliveryFile('next-delivery', 'removed.txt')
    assert.equal(deleted.before, 'remove me\n')
    assert.equal(deleted.after, null)
    await assert.rejects(ctx.ws.reviewDeliveryFile('next-delivery', '../app.txt'))
    await assert.rejects(ctx.ws.reviewDeliveryFile('next-delivery', 'not-in-manifest.txt'))
  })
}

test('review: binary, oversized and invalid UTF-8 do not become misleading text diffs', { timeout: 60_000 }, async (t) => {
  const ctx = await makeWorkspace('lachesis-review-bounds-')
  t.after(ctx.cleanup)
  const run = await ctx.ws.prepareRun({ runId: 'bounds', kind: 'files', projectRoot: ctx.projectRoot, targetBranch: null })
  await write(run.workspacePath, 'binary.bin', new Uint8Array([0, 1, 2]))
  await write(run.workspacePath, 'huge.txt', 'x'.repeat(128 * 1024 + 1))
  await write(run.workspacePath, 'invalid.txt', new Uint8Array([0xff, 0xfe, 0x61]))
  await ctx.ws.freezeDelivery({ runId: 'bounds', deliveryId: 'bounds-delivery', worker: stopped })
  assert.equal((await ctx.ws.reviewDeliveryFile('bounds-delivery', 'binary.bin')).binary, true)
  assert.equal((await ctx.ws.reviewDeliveryFile('bounds-delivery', 'invalid.txt')).binary, true)
  const huge = await ctx.ws.reviewDeliveryFile('bounds-delivery', 'huge.txt')
  assert.equal(huge.truncated, true)
  assert.equal(huge.after, null)
  assert.match(huge.unavailableReason!, /128 KB/)
  assert.equal((await ctx.ws.readDeliveryFile('bounds-delivery', 'huge.txt')).bytes.byteLength, 128 * 1024 + 1)
})
