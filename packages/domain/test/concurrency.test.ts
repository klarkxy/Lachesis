import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import type { Actor } from '../src/index.ts'
import { openTemp, operator, profileInput, projectInput, workerA, workerB } from './helpers.ts'
import { issueInput, idem } from './helpers.ts'

function claimInWorker(databasePath: string, actor: Actor, profileId: string): Promise<{
  ok: boolean
  runId: string | null
  issueId: string | null
  generation: number | null
  code?: string
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./claim-worker.ts', import.meta.url), {
      workerData: { databasePath, actor, profileId },
      execArgv: ['--experimental-strip-types'],
    })
    worker.once('message', (message) => resolve(message))
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`claim worker exited ${code}`))
    })
  })
}

test('concurrent claims produce one valid live run per issue', async (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const issue = domain.createIssue(operator, issueInput(project.id, profile.id, 'Race'), idem({ title: 'Race' }))
  domain.close()

  const [left, right] = await Promise.all([
    claimInWorker(databasePath, workerA, profile.id),
    claimInWorker(databasePath, workerB, profile.id),
  ])

  const wins = [left, right].filter((result) => result.ok && result.runId)
  const misses = [left, right].filter((result) => result.ok && result.runId === null)
  assert.equal(wins.length, 1, `expected one winner, got ${JSON.stringify({ left, right })}`)
  assert.equal(misses.length, 1)
  assert.equal(wins[0]?.issueId, issue.id)

  const { openDomain } = await import('../src/index.ts')
  const verify = openDomain({ databasePath, recoverInterrupted: false })
  try {
    const live = verify.listRuns(issue.id).filter((run) => ['starting', 'running', 'needs_input'].includes(run.status))
    assert.equal(live.length, 1)
    assert.equal(verify.getIssue(issue.id).currentRunId, live[0]?.id)
  } finally {
    verify.close()
  }
})

test('same profile can be claimed concurrently on two issues', async (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const one = domain.createIssue(operator, issueInput(project.id, profile.id, 'P1'), idem({ title: 'P1' }))
  const two = domain.createIssue(operator, issueInput(project.id, profile.id, 'P2'), idem({ title: 'P2' }))
  domain.close()

  const [left, right] = await Promise.all([
    claimInWorker(databasePath, workerA, profile.id),
    claimInWorker(databasePath, workerB, profile.id),
  ])

  assert.equal(left.ok && right.ok, true, JSON.stringify({ left, right }))
  const ids = [left.issueId, right.issueId].sort()
  assert.deepEqual(ids, [one.id, two.id].sort())
  assert.notEqual(left.runId, right.runId)
})

test('capacity remains atomic across concurrent database clients', async (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  domain.createIssue(operator, issueInput(project.id, profile.id, 'One'), idem('one'))
  domain.createIssue(operator, issueInput(project.id, profile.id, 'Two'), idem('two'))
  const current = domain.getSchedulerSettings()
  domain.updateSchedulerSettings(operator, { expectedVersion: current.version,
    globalMaxActive: 1, profileLimits: {}, providerLimits: {} })
  domain.close()
  const [left, right] = await Promise.all([
    claimInWorker(databasePath, workerA, profile.id),
    claimInWorker(databasePath, workerB, profile.id),
  ])
  assert.equal([left, right].filter((item) => item.runId).length, 1)
  const { openDomain } = await import('../src/index.ts')
  const verify = openDomain({ databasePath, recoverInterrupted: false })
  try {
    assert.equal(verify.getSchedulerSnapshot().activeRunCount, 1)
    assert.equal(verify.listIssues({ projectId: project.id, status: 'queued' }).items.length, 1)
  } finally { verify.close() }
})
