import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Issue, Profile, Project, ProjectDispatchState, SchedulerSnapshot, RunCheckpoint } from '@lachesis/contracts'
import type { DshAcpExecutor, RunHandle, RunOutcome, RunSpec } from '@lachesis/runtime'
import { LachesisApplication } from '../src/application.ts'

const actor = { kind: 'browser' as const, id: 'scheduler-test', projectIds: null, permissions: null }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class ControlledRuntime implements DshAcpExecutor {
  readonly starts: Array<{ spec: RunSpec; release(): void; close(): Promise<void> }> = []
  readiness = { ready: true, code: null as string | null, diagnostic: null as string | null }
  failFirst = false
  async checkReadiness() { return this.readiness }
  async start(spec: RunSpec): Promise<RunHandle> {
    const gate = deferred<void>()
    const done = deferred<RunOutcome>()
    const index = this.starts.length + 1
    let closed = false
    const close = async () => {
      closed = true
      gate.resolve()
      done.resolve({ state: 'closed', deliveryStatus: 'none', exitCode: 0, signal: null, rangeExited: true })
    }
    this.starts.push({ spec, release: () => gate.resolve(), close })
    const shouldFail = this.failFirst && index === 1
    return {
      runId: randomUUID(), sessionId: `controlled-${index}`, state: 'ready', deliveryStatus: 'none',
      route: undefined, processFacts: undefined, events: (async function* () {})(),
      async send() {
        await gate.promise
        if (closed) throw new Error('Controlled worker stopped')
        await writeFile(join(spec.cwd, `part-${index}.txt`), `work-${index}`)
        if (shouldFail) throw new Error('Controlled prompt timeout after edits')
        return { stopReason: 'end_turn', promptEnded: true }
      },
      answerPermission: async () => {}, cancel: close, close, done: done.promise,
    }
  }
  async closeAll() { await Promise.all(this.starts.map((run) => run.close())) }
}

async function until(check: () => boolean, explanation: string) {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(explanation)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, runtime = new ControlledRuntime(), verificationCommand?: string) {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-scheduling-'))
  const projectRoot = join(root, 'target')
  await mkdir(projectRoot)
  const app = await LachesisApplication.open(join(root, 'data'), runtime)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const invoke = (operation: string, input: Record<string, unknown> = {}) =>
    app.invoke(operation, input, { actor, idempotencyKey: randomUUID() })
  const project = await invoke('project.create', { name: 'Parallel', rootPath: projectRoot, kind: 'files',
    ...(verificationCommand ? { verificationCommand } : {}) }) as Project
  const profile = await invoke('profile.create', { name: 'Worker', avatarPresetId: 'default',
    providerRef: 'fixture', modelId: 'fixture', reasoningEffort: null }) as Profile
  const create = (title: string, extra: Record<string, unknown> = {}) => invoke('issue.create', {
    projectId: project.id, title, description: title, acceptanceCriteria: ['preserve isolated work'],
    dispatch: { mode: 'require', profileId: profile.id }, requesterRef: 'scheduler-test', ...extra,
  }) as Promise<Issue>
  return { app, invoke, project, profile, runtime, root, projectRoot, create }
}

test('four independent runs overlap under one Profile; fifth waits and pause preserves running work', async (t) => {
  const f = await fixture(t)
  f.app.start()
  const issues = []
  for (let index = 0; index < 5; index++) issues.push(await f.create(`Independent ${index}`))
  await until(() => f.runtime.starts.length === 4, 'four capacity slots were not filled')
  assert.equal(new Set(f.runtime.starts.map((run) => run.spec.cwd)).size, 4)
  assert.equal(new Set(f.runtime.starts.map((run) => run.spec.dshHome)).size, 4)
  const state = await f.invoke('project.dispatch', { projectId: f.project.id }) as ProjectDispatchState
  await f.invoke('project.pause', { projectId: f.project.id, paused: true, expectedVersion: state.version })
  const paused = await f.invoke('project.dispatch', { projectId: f.project.id }) as ProjectDispatchState
  assert.equal(paused.activeRunCount, 4)
  assert.equal(paused.drainComplete, false)
  const releasedIssue = issues.find((issue) => {
    const runId = f.app.domain.getIssue(issue.id).currentRunId
    return runId && f.app.domain.getRun(runId).run.workspacePath === f.runtime.starts[0]!.spec.cwd
  })!
  assert.ok(releasedIssue, 'started worker must be bound to its actual Issue')
  f.runtime.starts[0]!.release()
  await until(() => f.app.domain.getIssue(releasedIssue.id).status === 'awaiting_review', 'running work did not finish while paused')
  assert.equal(f.runtime.starts.length, 4)
  await f.invoke('project.pause', { projectId: f.project.id, paused: false, expectedVersion: paused.version })
  await until(() => f.runtime.starts.length === 5, 'resume did not start the fifth run')
})

test('environment failure prevents model start and persists until successful explicit recheck', async (t) => {
  const runtime = new ControlledRuntime()
  runtime.readiness = { ready: false, code: 'sandbox_acl_denied', diagnostic: 'Workspace grant lacks WRITE_OWNER' }
  const f = await fixture(t, runtime)
  const issue = await f.create('Cannot run')
  await until(() => f.app.domain.getIssue(issue.id).status === 'failed', 'preflight did not fail closed')
  assert.equal(runtime.starts.length, 0)
  const another = await f.create('Do not retry environment')
  const snapshot = await f.invoke('scheduler.get', { projectId: f.project.id }) as SchedulerSnapshot
  assert.equal(snapshot.decisions.find((item) => item.issueId === another.id)?.reason, 'environment')
  let state = await f.invoke('project.dispatch', { projectId: f.project.id }) as ProjectDispatchState
  assert.equal(state.environmentBlock?.code, 'sandbox_acl_denied')
  const failed = await f.invoke('project.readiness', { projectId: f.project.id, expectedVersion: state.version }) as { readiness: { ready: boolean } }
  assert.equal(failed.readiness.ready, false)
  state = await f.invoke('project.dispatch', { projectId: f.project.id }) as ProjectDispatchState
  runtime.readiness = { ready: true, code: null, diagnostic: null }
  await f.invoke('project.readiness', { projectId: f.project.id, expectedVersion: state.version })
  await until(() => runtime.starts.length === 1, 'ready work did not resume after recheck')
})

test('failed run preserves a stopped checkpoint, which resumes explicitly without becoming a Delivery', async (t) => {
  const runtime = new ControlledRuntime()
  runtime.failFirst = true
  const f = await fixture(t, runtime)
  const issue = await f.create('Preserve progress')
  await until(() => runtime.starts.length === 1, 'first run missing')
  runtime.starts[0]!.release()
  await until(() => f.app.domain.listCheckpoints(issue.id).length === 1, 'failed work did not become an unfinished checkpoint')
  const checkpoint = f.app.domain.listCheckpoints(issue.id)[0]!
  assert.equal(f.app.domain.getIssueDetail(issue.id).deliveries.length, 0)
  await assert.rejects(f.invoke('issue.accept', { issueId: issue.id, deliveryId: checkpoint.id,
    expectedIssueVersion: f.app.domain.getIssue(issue.id).version }))
  const again = await f.invoke('run.checkpoint', { runId: checkpoint.runId }) as RunCheckpoint
  assert.equal(again.id, checkpoint.id)
  await f.invoke('issue.resume', { issueId: issue.id, checkpointId: checkpoint.id,
    expectedIssueVersion: f.app.domain.getIssue(issue.id).version })
  await until(() => runtime.starts.length === 2, 'checkpoint resume did not start a new run')
  assert.equal(await readFile(join(runtime.starts[1]!.spec.cwd, 'part-1.txt'), 'utf8'), 'work-1')
  runtime.starts[1]!.release()
  await until(() => f.app.domain.getIssue(issue.id).status === 'awaiting_review', 'resumed run did not produce a delivery')
  assert.deepEqual(f.app.domain.getIssueDetail(issue.id).deliveries[0]!.files.map((file) => file.path).sort(), ['part-1.txt', 'part-2.txt'])
})

test('new control operations enforce caller scope and reject duplicate physical targets', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.invoke('project.create', { name: 'Alias', kind: 'files', rootPath: join(f.projectRoot, '.') }), /overlaps/)
  const issue = await f.create('Scoped')
  const token = { kind: 'token' as const, id: 'limited', projectIds: [] as string[], permissions: ['*'] }
  for (const [operation, input] of [
    ['project.pause', { projectId: f.project.id, paused: true, expectedVersion: 0 }],
    ['scheduler.get', { projectId: f.project.id }],
    ['issue.checkpoints', { issueId: issue.id }],
    ['issue.plan', { issueId: issue.id, expectedIssueVersion: issue.version, dependsOn: [] }],
  ] as const) {
    await assert.rejects(f.app.invoke(operation, input, { actor: token, idempotencyKey: null }), /cannot access/)
  }
  await assert.rejects(f.app.invoke('scheduler.update', { expectedVersion: 1, globalMaxActive: 8, profileLimits: {}, providerLimits: {} },
    { actor: token, idempotencyKey: null }), /local operator/)
})

test('shutdown drains accepted integration before releasing the database lease', async (t) => {
  const f = await fixture(t)
  const issue = await f.create('Integrate before shutdown')
  await until(() => f.runtime.starts.length === 1, 'worker did not start')
  f.runtime.starts[0]!.release()
  await until(() => f.app.domain.getIssue(issue.id).status === 'awaiting_review', 'delivery missing')
  const detail = f.app.domain.getIssueDetail(issue.id)
  const deliveryId = detail.deliveries[0]!.id
  const accepted = await f.invoke('issue.accept', { issueId: issue.id, deliveryId, expectedIssueVersion: detail.issue.version }) as Issue
  const entered = deferred<void>()
  const finish = deferred<void>()
  const original = f.app.supervisor.workspace.integrate.bind(f.app.supervisor.workspace)
  f.app.supervisor.workspace.integrate = async (input) => { entered.resolve(); await finish.promise; return original(input) }
  const preparing = f.invoke('application.prepare', { issueId: issue.id, deliveryId, expectedIssueVersion: accepted.version })
  await entered.promise
  let closed = false
  const closing = f.app.close().then(() => { closed = true })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false)
    await assert.rejects(LachesisApplication.open(f.app.dataRoot, new ControlledRuntime()), /already in use/)
    await assert.rejects(f.invoke('project.list'), /stopping/)
  } finally { finish.resolve() }
  const candidate = await preparing as { status: string }
  assert.equal(candidate.status, 'ready')
  await closing
  const reopened = await LachesisApplication.open(f.app.dataRoot, new ControlledRuntime())
  await reopened.close()
})

test('rework receives late failure details as a readable diagnostic excluded from its delivery', async (t) => {
  const f = await fixture(t, new ControlledRuntime(), 'node verify.mjs')
  await writeFile(join(f.projectRoot, 'verify.mjs'), `import { existsSync } from 'node:fs';
if (!existsSync('part-2.txt')) { console.log('passed earlier test\\n'.repeat(900)); console.error('Error: missing second part at verify.mjs:2'); process.exit(1) }
`)
  const issue = await f.create('Read failure evidence')
  await until(() => f.runtime.starts.length === 1, 'first worker missing')
  f.runtime.starts[0]!.release()
  await until(() => f.app.domain.getIssue(issue.id).status === 'awaiting_review', 'first delivery missing')
  const detail = f.app.domain.getIssueDetail(issue.id)
  const deliveryId = detail.deliveries[0]!.id
  const accepted = await f.invoke('issue.accept', { issueId: issue.id, deliveryId, expectedIssueVersion: detail.issue.version }) as Issue
  const candidate = await f.invoke('application.prepare', { issueId: issue.id, deliveryId, expectedIssueVersion: accepted.version }) as { status: string }
  assert.equal(candidate.status, 'failed')
  await f.invoke('issue.rework', { issueId: issue.id, deliveryId, expectedIssueVersion: accepted.version, instructions: 'Add the missing part' })
  await until(() => f.runtime.starts.length === 2, 'rework worker missing')
  const report = JSON.parse(await readFile(join(f.runtime.starts[1]!.spec.cwd, '.dsh/lachesis-verification.json'), 'utf8'))
  assert.match(report.output, /missing second part/)
  assert.match(report.summary, /missing second part/)
  f.runtime.starts[1]!.release()
  await until(() => f.app.domain.getIssue(issue.id).status === 'awaiting_review', 'rework delivery missing')
  const files = f.app.domain.getIssueDetail(issue.id).deliveries.at(-1)!.files
  assert.ok(files.some((file) => file.path === 'part-2.txt'))
  assert.equal(files.some((file) => file.path.startsWith('.dsh/')), false)
})

test('parallel deliveries survive ordered apply and stale candidates must be prepared again', async (t) => {
  const f = await fixture(t)
  const left = await f.create('Left independent change')
  const right = await f.create('Right independent change')
  await until(() => f.runtime.starts.length === 2, 'parallel workers missing')
  f.runtime.starts.forEach((run) => run.release())
  await until(() => [left, right].every((issue) => f.app.domain.getIssue(issue.id).status === 'awaiting_review'), 'parallel deliveries missing')
  const prepare = async (id: string) => {
    const detail = f.app.domain.getIssueDetail(id)
    const deliveryId = detail.deliveries[0]!.id
    const accepted = detail.issue.status === 'accepted' ? detail.issue : await f.invoke('issue.accept', {
      issueId: id, deliveryId, expectedIssueVersion: detail.issue.version,
    }) as Issue
    return await f.invoke('application.prepare', { issueId: id, deliveryId, expectedIssueVersion: accepted.version }) as {
      id: string; status: string; expectedTarget: string
    }
  }
  const a = await prepare(left.id)
  const b = await prepare(right.id)
  assert.equal(a.status, 'ready')
  assert.equal(b.status, 'ready')
  const first = await f.invoke('application.apply', { applicationId: a.id, expectedTarget: a.expectedTarget }) as { status: string }
  assert.equal(first.status, 'applied')
  const stale = await f.invoke('application.apply', { applicationId: b.id, expectedTarget: b.expectedTarget }) as { status: string }
  assert.equal(stale.status, 'failed')
  const fresh = await prepare(right.id)
  assert.notEqual(fresh.id, b.id)
  assert.equal(fresh.status, 'ready')
  const applied = await f.invoke('application.apply', { applicationId: fresh.id, expectedTarget: fresh.expectedTarget }) as { status: string }
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(f.projectRoot, 'part-1.txt'), 'utf8'), 'work-1')
  assert.equal(await readFile(join(f.projectRoot, 'part-2.txt'), 'utf8'), 'work-2')
})
