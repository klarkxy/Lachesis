import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Application, Issue, Profile, Project } from '@lachesis/contracts'
import type { DshAcpExecutor, RunEvent, RunHandle, RunSpec } from '@lachesis/runtime'
import { LachesisApplication } from '../src/application.ts'

const browser = { kind: 'browser' as const, id: 'test-operator', projectIds: null, permissions: null }

class FakeAcp implements DshAcpExecutor {
  private starts = 0
  readonly prompts: string[] = []
  constructor(
    private readonly fileForAttempt: (attempt: number) => string = () => 'result.txt',
    private readonly replyChunks: string[] = [],
  ) {}
  async start(spec: RunSpec): Promise<RunHandle> {
    const file = this.fileForAttempt(++this.starts)
    const runId = randomUUID()
    const sessionId = `session-${runId}`
    const replyChunks = this.replyChunks
    const prompts = this.prompts
    return {
      runId,
      sessionId,
      state: 'ready',
      deliveryStatus: 'pending_acceptance',
      route: undefined,
      processFacts: undefined,
      events: (async function* () {
        for (const text of replyChunks) {
          yield { type: 'acp_update', sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } as RunEvent
        }
      })(),
      async send(prompt: string) {
        prompts.push(prompt)
        await writeFile(join(spec.cwd, file), 'finished by isolated worker\n')
        return { stopReason: 'end_turn', promptEnded: true }
      },
      async answerPermission() {},
      async cancel() {},
      async close() {},
      done: Promise.resolve({ state: 'closed', deliveryStatus: 'pending_acceptance',
        stopReason: 'end_turn', exitCode: 0, signal: null, rangeExited: true }),
    }
  }
  async closeAll(): Promise<void> {}
}

test('ACP text split across events cannot persist an environment credential in logs or delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-server-redaction-'))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const secret = 'synthetic-secret-123456789'
  process.env.LACHESIS_TEST_SECRET_KEY = secret
  const app = await LachesisApplication.open(join(root, 'data'), new FakeAcp(
    () => 'result.txt', [`Report: ${secret.slice(0, 10)}`, `${secret.slice(10)} done.`],
  ))
  const invoke = (operation: string, input: Record<string, unknown>, key: string | null = null) =>
    app.invoke(operation, input, { actor: browser, idempotencyKey: key })
  try {
    const project = await invoke('project.create', { name: 'Redaction', kind: 'files', rootPath: projectRoot }) as Project
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake-model', reasoningEffort: null }) as Profile
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Report', description: 'Write result',
      acceptanceCriteria: ['result'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'redaction-issue') as Issue
    const deadline = Date.now() + 8_000
    let detail = app.domain.getIssueDetail(issue.id)
    while (detail.issue.status !== 'awaiting_review') {
      if (detail.issue.status === 'failed' || Date.now() > deadline) assert.fail('Run did not finish')
      await new Promise((resolve) => setTimeout(resolve, 40))
      detail = app.domain.getIssueDetail(issue.id)
    }
    const delivery = detail.deliveries[0]!
    assert.equal(delivery.finalResponse, 'Report: [redacted] done.')
    assert.equal(delivery.summary, 'Report: [redacted] done.')
    const events = app.domain.listEvents({ runId: detail.runs[0]!.id }).items
    assert.ok(events.some((event) => event.type === 'run.acp_update'))
    assert.equal(JSON.stringify(events).includes(secret), false)
    assert.equal(JSON.stringify(detail).includes(secret), false)
  } finally {
    await app.close()
    delete process.env.LACHESIS_TEST_SECRET_KEY
    await rm(root, { recursive: true, force: true })
  }
})

test('Issue executes in an isolated directory, freezes, integrates, and applies only on request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-server-workflow-'))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'original.txt'), 'untouched\n')
  const app = await LachesisApplication.open(join(root, 'data'), new FakeAcp())
  const invoke = (operation: string, input: Record<string, unknown>, key: string | null = null) =>
    app.invoke(operation, input, { actor: browser, idempotencyKey: key })
  try {
    const project = await invoke('project.create', { name: 'Fixture', kind: 'files', rootPath: projectRoot }) as Project
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake-model', reasoningEffort: null }) as Profile
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Write result', description: 'Add result.txt',
      acceptanceCriteria: ['result.txt exists'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'issue-1') as Issue
    let detail: Awaited<ReturnType<typeof app.domain.getIssueDetail>>
    const deadline = Date.now() + 8_000
    for (;;) {
      detail = app.domain.getIssueDetail(issue.id)
      if (detail.issue.status === 'awaiting_review') break
      if (detail.issue.status === 'failed') assert.fail('Run failed before freezing a delivery')
      if (Date.now() > deadline) assert.fail('Run did not reach review')
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.equal(detail.deliveries.length, 1)
    assert.equal(detail.deliveries[0]?.files[0]?.path, 'result.txt')
    await assert.rejects(readFile(join(projectRoot, 'result.txt')))
    const accepted = await invoke('issue.accept', { issueId: issue.id, deliveryId: detail.deliveries[0]!.id,
      expectedIssueVersion: detail.issue.version }) as Issue
    const candidate = await invoke('application.prepare', { issueId: issue.id, deliveryId: detail.deliveries[0]!.id,
      expectedIssueVersion: accepted.version }, 'integration-1') as Application
    assert.equal(candidate.status, 'ready')
    await assert.rejects(readFile(join(projectRoot, 'result.txt')))
    const applied = await invoke('application.apply', { applicationId: candidate.id,
      expectedTarget: candidate.expectedTarget }, 'apply-1') as Application
    assert.equal(applied.status, 'applied')
    assert.equal(await readFile(join(projectRoot, 'result.txt'), 'utf8'), 'finished by isolated worker\n')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rework uses the prior frozen delivery as the next Run starting point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-server-rework-'))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const worker = new FakeAcp((attempt) => attempt === 1 ? 'first.txt' : 'second.txt')
  const app = await LachesisApplication.open(join(root, 'data'), worker)
  const invoke = (operation: string, input: Record<string, unknown>, key: string | null = null) =>
    app.invoke(operation, input, { actor: browser, idempotencyKey: key })
  try {
    const project = await invoke('project.create', { name: 'Rework', kind: 'files', rootPath: projectRoot }) as Project
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake-model', reasoningEffort: null }) as Profile
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Two edits', description: 'Make two edits',
      acceptanceCriteria: ['Both files exist'], dispatch: { mode: 'require', profileId: profile.id },
      requesterRef: 'test' }, 'rework-issue') as Issue
    const deadline = Date.now() + 10_000
    let first = app.domain.getIssueDetail(issue.id)
    while (first.issue.status !== 'awaiting_review') {
      if (first.issue.status === 'failed' || Date.now() > deadline) assert.fail('First Run did not finish')
      await new Promise((resolve) => setTimeout(resolve, 40))
      first = app.domain.getIssueDetail(issue.id)
    }
    const reworked = await invoke('issue.rework', { issueId: issue.id, deliveryId: first.deliveries[0]!.id,
      instructions: 'Add the second file', expectedIssueVersion: first.issue.version }) as Issue
    assert.equal(reworked.status, 'queued')
    let second = app.domain.getIssueDetail(issue.id)
    while (second.issue.status !== 'awaiting_review' || second.runs.length < 2) {
      if (second.issue.status === 'failed' || Date.now() > deadline) assert.fail('Rework Run did not finish')
      await new Promise((resolve) => setTimeout(resolve, 40))
      second = app.domain.getIssueDetail(issue.id)
    }
    assert.equal(second.runs.length, 2)
    assert.deepEqual(second.deliveries[1]?.files.map((file) => file.path).sort(), ['first.txt', 'second.txt'])
    assert.match(worker.prompts[1]!, /Operator follow-up:\nAdd the second file/)
    assert.equal(second.comments.find((comment) => comment.text === 'Add the second file')?.delivered, true)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
