import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Issue, Profile, Project } from '@lachesis/contracts'
import type { RunSpec } from '@lachesis/plugin-runtime-dsh'
import { LachesisApplication } from '../src/application.ts'
import { AuthStore } from '../src/auth.ts'
import { handleHttpApi } from '../src/http.ts'

test('delivery review enforces permission and project scope before reading frozen bytes', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-review-http-'))
  const target = join(root, 'target')
  await mkdir(target)
  await writeFile(join(target, 'result.txt'), 'before\n')
  const runtime = {
    async start(spec: RunSpec) {
      return { runId: randomUUID(), sessionId: 'review-test', state: 'ready' as const, deliveryStatus: 'pending_acceptance' as const,
        events: (async function* () {})(), async send() { await writeFile(join(spec.cwd, 'result.txt'), 'after\n'); return { stopReason: 'end_turn' as const, promptEnded: true } },
        async answerPermission() {}, async cancel() {}, async close() {},
        done: Promise.resolve({ state: 'closed' as const, deliveryStatus: 'pending_acceptance' as const, stopReason: 'end_turn', exitCode: 0, signal: null, rangeExited: true }) }
    }, async closeAll() {},
  }
  const app = await LachesisApplication.open(join(root, 'data'), runtime)
  const actor = { kind: 'browser' as const, id: 'test', projectIds: null, permissions: null }
  const invoke = (op: string, input: Record<string, unknown>, key: string | null = null) => app.invoke(op, input, { actor, idempotencyKey: key })
  const auth = new AuthStore(join(root, 'data'))
  const server = createServer((req, res) => { void handleHttpApi(req, res, auth, app, () => {}) })
  try {
    const project = await invoke('project.create', { name: 'Review', kind: 'files', rootPath: target }) as Project
    const profile = await invoke('profile.create', { name: 'Builder', avatarPresetId: 'default', providerRef: 'fake', modelId: 'fake-model', reasoningEffort: null }) as Profile
    app.start()
    const issue = await invoke('issue.create', { projectId: project.id, title: 'Change', description: 'Change result', acceptanceCriteria: [], dispatch: { mode: 'require', profileId: profile.id }, requesterRef: 'test' }, 'review-http') as Issue
    let detail = app.domain.getIssueDetail(issue.id)
    const deadline = Date.now() + 8_000
    while (detail.issue.status !== 'awaiting_review') {
      if (Date.now() > deadline || detail.issue.status === 'failed') assert.fail(JSON.stringify(detail))
      await new Promise((resolve) => setTimeout(resolve, 40))
      detail = app.domain.getIssueDetail(issue.id)
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/api/v1/deliveries/${detail.deliveries[0]!.id}/review?path=result.txt`
    const get = (token?: string) => fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    assert.equal((await get()).status, 401)
    assert.equal((await get(auth.createToken([project.id], ['issue.read']).token)).status, 403)
    assert.equal((await get(auth.createToken(['other-project'], ['delivery.read']).token)).status, 403)
    const allowed = auth.createToken([project.id], ['delivery.read'])
    const response = await get(allowed.token)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await response.json() as { data: unknown }).data, { path: 'result.txt', kind: 'modified', before: 'before\n', after: 'after\n', binary: false, truncated: false, unavailableReason: null })
    assert.equal((await fetch(url.replace('result.txt', '..%2Fresult.txt'), { headers: { authorization: `Bearer ${allowed.token}` } })).status, 400)
    const accepted = await invoke('issue.accept', { issueId: issue.id, deliveryId: detail.deliveries[0]!.id, expectedIssueVersion: detail.issue.version }) as Issue
    const projectedStatus = async () => ((await invoke('issue.list', { projectId: project.id })) as { items: Array<Issue & { applicationStatus: string | null }> }).items.find(item => item.id === issue.id)?.applicationStatus
    assert.equal(await projectedStatus(), null)
    let candidate = await invoke('application.prepare', { issueId: issue.id, deliveryId: detail.deliveries[0]!.id, expectedIssueVersion: accepted.version }, 'review-candidate') as { id: string; status: string; expectedTarget: string | null }
    const readyDeadline = Date.now() + 8_000
    while (candidate.status !== 'ready') {
      if (Date.now() > readyDeadline || ['failed', 'conflict'].includes(candidate.status)) assert.fail(JSON.stringify(candidate))
      await new Promise(resolve => setTimeout(resolve, 40))
      candidate = app.domain.getApplication(candidate.id)
    }
    assert.equal(await projectedStatus(), 'ready')
    await invoke('application.apply', { applicationId: candidate.id, expectedTarget: candidate.expectedTarget }, 'review-apply')
    const applyDeadline = Date.now() + 8_000
    while (app.domain.getApplication(candidate.id).status !== 'applied') {
      if (Date.now() > applyDeadline) assert.fail('Application did not finish')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    assert.equal(await projectedStatus(), 'applied')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
