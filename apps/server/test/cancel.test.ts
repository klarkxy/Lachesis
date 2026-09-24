import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { RangeExitUnconfirmedError, type DshAcpExecutor, type RunHandle } from '@lachesis/runtime'
import { LachesisApplication } from '../src/application.ts'

for (const rangeExited of [true, false] as const) test(
  rangeExited
    ? 'cancellation closes the range even when the ACP cancel notification fails'
    : 'unconfirmed cancellation enters durable recovery state instead of false running',
  async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-cancel-'))
  const target = join(root, 'target')
  await mkdir(target)
  let rejectPrompt: ((error: Error) => void) | undefined
  let app: LachesisApplication
  let issueId: string
  let pendingQuestionId: string | undefined
  const executor: DshAcpExecutor = {
    async start(): Promise<RunHandle> {
      return {
        runId: 'fake-run', sessionId: 'fake-session', state: 'ready', deliveryStatus: 'none',
        route: undefined, processFacts: undefined, events: (async function* () {})(),
        send: () => new Promise((_, reject) => { rejectPrompt = reject }),
        async answerPermission() {},
        async cancel() {
          if (rangeExited) {
            const runId = app.domain.getIssue(issueId).currentRunId!
            const generation = app.domain.getRun(runId).facts.generation
            const question = app.domain.askQuestion({ kind: 'worker', id: 'fake' }, runId, generation, [{
              id: 'optionId', text: 'Allow this action?', options: ['allow', 'deny'], required: true,
            }])
            pendingQuestionId = question.id
          }
          throw new Error('ACP cancellation timed out')
        },
        async close() { rejectPrompt?.(new Error('range closed')) },
        done: Promise.resolve({ state: 'closed', deliveryStatus: 'none', exitCode: 0,
          signal: null, rangeExited }),
      }
    },
    async closeAll() { rejectPrompt?.(new Error('executor closing')) },
  }
  app = await LachesisApplication.open(join(root, 'data'), executor)
  const actor = { kind: 'browser' as const, id: 'operator', projectIds: null, permissions: null }
  const invoke = (operation: string, input: Record<string, unknown>, idempotencyKey: string | null = null) =>
    app.invoke(operation, input, { actor, idempotencyKey })
  try {
    const project = await invoke('project.create', { name: 'Cancel', kind: 'files', rootPath: target }) as { id: string }
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake', reasoningEffort: null }) as { id: string }
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Long task', description: 'Wait',
      acceptanceCriteria: ['cancelled'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'cancel-issue') as { id: string }
    issueId = issue.id
    const deadline = Date.now() + 8_000
    let current
    do {
      current = app.domain.getIssue(issue.id)
      if (current.status === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(current.status, 'running')
    if (rangeExited) {
      const cancelled = await invoke('issue.cancel', { issueId: issue.id,
        expectedIssueVersion: current.version }) as { status: string }
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(app.domain.getIssue(issue.id).status, 'cancelled')
      assert.deepEqual(app.domain.listPendingQuestions(issue.id), [])
      assert.ok(pendingQuestionId)
      assert.throws(() => app.domain.answerQuestion({ kind: 'operator', id: 'operator' },
        app.domain.getIssue(issue.id).currentRunId!, pendingQuestionId!, { optionId: 'allow' }),
      /no longer active/)
    } else {
      await assert.rejects(
        invoke('issue.cancel', { issueId: issue.id, expectedIssueVersion: current.version }),
        /Worker exit is unconfirmed/,
      )
      assert.equal(app.domain.getIssue(issue.id).status, 'recovery_required')
      assert.equal(app.domain.getRun(app.domain.getIssue(issue.id).currentRunId!).run.status, 'recovery_required')
    }
  } finally {
    await app.close()
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing to remove a non-temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

test('unconfirmed startup teardown fences the Issue before another attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-start-unconfirmed-'))
  const target = join(root, 'target')
  await mkdir(target)
  const executor: DshAcpExecutor = {
    async start() { throw new RangeExitUnconfirmedError('managed range exit unconfirmed') },
    async closeAll() {},
  }
  const app = await LachesisApplication.open(join(root, 'data'), executor)
  const actor = { kind: 'browser' as const, id: 'operator', projectIds: null, permissions: null }
  const invoke = (operation: string, input: Record<string, unknown>, idempotencyKey: string | null = null) =>
    app.invoke(operation, input, { actor, idempotencyKey })
  try {
    const project = await invoke('project.create', { name: 'Startup', kind: 'files', rootPath: target }) as { id: string }
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake', reasoningEffort: null }) as { id: string }
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Startup', description: 'Wait',
      acceptanceCriteria: ['fenced'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'startup-unconfirmed') as { id: string }
    const deadline = Date.now() + 8_000
    let current
    do {
      current = app.domain.getIssue(issue.id)
      if (current.status === 'recovery_required') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(current.status, 'recovery_required')
    assert.equal(app.domain.getRun(current.currentRunId!).run.status, 'recovery_required')
  } finally {
    await app.close()
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing to remove a non-temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
