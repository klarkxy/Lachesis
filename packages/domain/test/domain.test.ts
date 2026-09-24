import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DomainError, ErrorCode, hasDependencyCycle, openDomain } from '../src/index.ts'
import {
  delivery,
  idem,
  issueInput,
  openTemp,
  operator,
  profileInput,
  seedBasic,
  workerA,
} from './helpers.ts'

test('transactional migration is recorded on the real temp database', (t) => {
  const { domain, databasePath } = openTemp(t)
  assert.equal(domain.schemaVersion(), 2)
  domain.close()
  const again = openDomain({ databasePath, recoverInterrupted: false })
  assert.equal(again.schemaVersion(), 2)
  again.close()
})

test('project and profile revisions use CAS; scores aggregate by revision', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  assert.equal(domain.listProjects().items.length, 1)
  assert.equal(profile.revision, 1)

  const renamed = domain.updateProfile(operator, profile.id, { name: 'Builder 2' }, 1)
  assert.equal(renamed.revision, 1)

  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  domain.failRun(workerA, claim.run.id, claim.generation, 'model crashed')
  const failed = domain.getIssue(issue.id)
  const evaluation = domain.evaluateIssue(operator, issue.id, {
    runId: claim.run.id,
    score: 2,
    comment: 'failed run still counts',
    expectedIssueVersion: failed.version,
  }, idem({ score: 2 }))
  assert.equal(evaluation.active, true)
  assert.equal(evaluation.profileRevision, 1)

  const bumped = domain.updateProfile(operator, profile.id, { modelId: 'v4' }, 1)
  assert.equal(bumped.revision, 2)
  assert.equal(domain.listProfileRevisions(profile.id).length, 2)
  assert.throws(
    () => domain.updateProfile(operator, profile.id, { modelId: 'v5' }, 1),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.versionConflict,
  )

  const issue2 = domain.createIssue(operator, issueInput(project.id, profile.id, 'Second'), idem({ title: 'Second' }))
  const claim2 = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim2)
  assert.equal(claim2.run.profileRevision, 2)
  const done = domain.completeRun(workerA, claim2.run.id, claim2.generation, delivery('sha-2'))
  const after = domain.getIssue(issue2.id)
  domain.evaluateIssue(operator, issue2.id, {
    runId: claim2.run.id,
    deliveryId: done.id,
    score: 5,
    comment: 'good',
    expectedIssueVersion: after.version,
  }, idem({ score: 5 }))

  const history = domain.listProfileHistory(profile.id)
  assert.equal(history.length, 2)
  const r1 = history.find((entry) => entry.revision === 1)
  const r2 = history.find((entry) => entry.revision === 2)
  assert.equal(r1?.evaluatedCount, 1)
  assert.equal(r1?.averageScore, 2)
  assert.deepEqual(r1?.issueIds, [issue.id])
  assert.equal(r2?.evaluatedCount, 1)
  assert.equal(r2?.averageScore, 5)
})

test('duplicate issue submit is idempotent; different body conflicts', (t) => {
  const { domain } = openTemp(t)
  const { project, profile } = seedBasic(domain, 'Seed')
  const input = issueInput(project.id, profile.id, 'Same')
  const key = 'issue-key-1'
  const first = domain.createIssue(operator, input, { key, body: input })
  const replay = domain.createIssue(operator, input, { key, body: input })
  assert.equal(replay.id, first.id)
  const other = { ...input, title: 'Other' }
  assert.throws(
    () => domain.createIssue(operator, other, { key, body: other }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.idempotencyConflict,
  )
  const viaClient = domain.createIssue(operator, { ...input, title: 'Same', clientRequestId: 'req-1' }, idem(input))
  const viaClientAgain = domain.createIssue(operator, { ...input, title: 'Same', clientRequestId: 'req-1' }, idem({ x: 1 }))
  assert.equal(viaClientAgain.id, viaClient.id)
})

test('required dispatch rejects disabled profiles and disabling cannot strand pending issues', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  assert.throws(
    () => domain.updateProfile(operator, profile.id, { disabled: true }, profile.revision),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict &&
      (error.details as { issueId?: string }).issueId === issue.id,
  )
  assert.equal(domain.getProfile(profile.id).disabled, false)

  const blocked = domain.createIssue(operator, {
    ...issueInput(project.id, profile.id, 'Dependent'),
    dependsOn: [issue.id],
  }, idem({ title: 'Dependent' }))
  domain.cancelIssue(operator, issue.id, issue.version)
  assert.equal(domain.getIssue(blocked.id).status, 'blocked')
  assert.throws(
    () => domain.updateProfile(operator, profile.id, { disabled: true }, profile.revision),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  domain.cancelIssue(operator, blocked.id, blocked.version)
  assert.equal(domain.updateProfile(operator, profile.id, { disabled: true }, profile.revision).disabled, true)

  const count = domain.listIssues({ projectId: project.id }).items.length
  assert.throws(
    () => domain.createIssue(operator, issueInput(project.id, profile.id, 'Cannot queue'), idem({ title: 'Cannot queue' })),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict &&
      error.message === 'Required dispatch Profile is disabled',
  )
  assert.equal(domain.listIssues({ projectId: project.id }).items.length, count)
})

test('retry and rework cannot requeue a required issue after its Profile is disabled', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  const failedClaim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(failedClaim)
  domain.failRun(workerA, failedClaim.run.id, failedClaim.generation, 'failure')
  domain.updateProfile(operator, profile.id, { disabled: true }, profile.revision)
  const failed = domain.getIssue(issue.id)
  assert.throws(
    () => domain.retryIssue(operator, issue.id, failed.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  assert.equal(domain.getIssue(issue.id).status, 'failed')

  domain.updateProfile(operator, profile.id, { disabled: false }, profile.revision)
  const review = domain.createIssue(operator, issueInput(project.id, profile.id, 'Review'), idem({ title: 'Review' }))
  const reviewClaim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(reviewClaim)
  const delivered = domain.completeRun(workerA, reviewClaim.run.id, reviewClaim.generation, delivery('sha-review'))
  domain.updateProfile(operator, profile.id, { disabled: true }, profile.revision)
  const awaiting = domain.getIssue(review.id)
  assert.throws(
    () => domain.reworkIssue(operator, review.id, delivered.id, 'Revise', awaiting.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  assert.equal(domain.getIssue(review.id).status, 'awaiting_review')
})

test('circular dependencies are rejected and do not hang', (t) => {
  assert.equal(hasDependencyCycle(new Map([['a', ['b']], ['b', ['a']]])), true)
  assert.equal(hasDependencyCycle(new Map([['a', ['b']], ['b', []]])), false)

  const { domain, databasePath } = openTemp(t)
  const { project, profile, issue: a } = seedBasic(domain, 'A')
  const b = domain.createIssue(operator, issueInput(project.id, profile.id, 'B'), idem({ title: 'B' }))
  domain.close()

  const raw = new DatabaseSync(databasePath)
  raw.prepare('INSERT INTO issue_dependencies (issue_id, depends_on) VALUES (?, ?)').run(a.id, b.id)
  raw.prepare('INSERT INTO issue_dependencies (issue_id, depends_on) VALUES (?, ?)').run(b.id, a.id)
  raw.close()

  const reopened = openDomain({ databasePath, recoverInterrupted: false })
  try {
    assert.throws(
      () => reopened.createIssue(operator, { ...issueInput(project.id, profile.id, 'C'), dependsOn: [a.id] }, idem({ title: 'C' })),
      (error: unknown) => error instanceof DomainError && error.code === ErrorCode.circularDependency,
    )
  } finally {
    reopened.close()
  }
})

test('file-changing dependency unblocks only after accepted delivery is applied', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue: dep } = seedBasic(domain, 'Dep')
  const blocked = domain.createIssue(
    operator,
    { ...issueInput(project.id, profile.id, 'Child'), dependsOn: [dep.id] },
    idem({ title: 'Child' }),
  )
  assert.equal(blocked.status, 'blocked')
  assert.equal(domain.claimReadyIssue(workerA, { profileId: profile.id })?.issue.id, dep.id)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.equal(claim, null)

  const depClaim = domain.listRuns(dep.id)[0]
  assert.ok(depClaim)
  const facts = domain.getRun(depClaim.id)
  const delivered = domain.completeRun(workerA, depClaim.id, facts.facts.generation, delivery())
  const awaiting = domain.getIssue(dep.id)
  domain.acceptIssue(operator, dep.id, delivered.id, awaiting.version)
  assert.equal(domain.getIssue(blocked.id).status, 'blocked')
  const accepted = domain.getIssue(dep.id)
  const integration = domain.createIntegration(operator, dep.id, delivered.id, accepted.version, idem({ deliveryId: delivered.id }))
  domain.reportApplicationOutcome(operator, integration.id, { status: 'applied', resultTarget: 'commit' })
  assert.equal(domain.getIssue(blocked.id).status, 'queued')
})

test('same profile can own multiple live runs; a second claim on one issue loses', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain, 'One')
  const two = domain.createIssue(operator, issueInput(project.id, profile.id, 'Two'), idem({ title: 'Two' }))
  const first = domain.claimReadyIssue(workerA, { profileId: profile.id })
  const second = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first.issue.id, second.issue.id)
  assert.equal(first.run.profileId, profile.id)
  assert.equal(second.run.profileId, profile.id)
  assert.equal(domain.claimReadyIssue(workerA, { profileId: profile.id }), null)
  assert.ok([issue.id, two.id].includes(first.issue.id))
})

test('run completion stays awaiting_review; rework keeps the old run', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const replay = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  assert.equal(replay.id, delivered.id)
  const awaiting = domain.getIssue(issue.id)
  assert.equal(awaiting.status, 'awaiting_review')
  assert.equal(awaiting.acceptedDeliveryId, null)

  const reworked = domain.reworkIssue(operator, issue.id, delivered.id, 'please fix the edge case', awaiting.version)
  assert.equal(reworked.status, 'queued')
  assert.equal(domain.getRun(claim.run.id).run.status, 'completed')
  assert.throws(
    () => domain.completeRun(workerA, claim.run.id, claim.generation, delivery('sha-late')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.lateResult,
  )

  const next = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(next)
  assert.notEqual(next.run.id, claim.run.id)
  assert.equal(next.run.attempt, 2)
  assert.equal(domain.listRuns(issue.id).length, 2)
})

test('accepted delivery with failed integration can be reworked without losing its history', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const accepted = domain.acceptIssue(operator, issue.id, delivered.id, domain.getIssue(issue.id).version)
  const integration = domain.createIntegration(operator, issue.id, delivered.id, accepted.version, idem({ deliveryId: delivered.id }))
  domain.reportApplicationOutcome(operator, integration.id, { status: 'failed', diagnostic: 'verification failed' })

  const reworked = domain.reworkIssue(operator, issue.id, delivered.id, 'Repair the failing test', accepted.version)
  assert.equal(reworked.status, 'queued')
  assert.equal(reworked.acceptedDeliveryId, null)
  assert.equal(domain.getReworkSourceDelivery(issue.id), delivered.id)
  assert.equal(domain.getDelivery(delivered.id).id, delivered.id)
  assert.equal(domain.getRun(claim.run.id).run.status, 'completed')
  assert.equal(domain.getApplication(integration.id).status, 'failed')
  assert.equal(domain.listComments(issue.id)[0]?.text, 'Repair the failing test')
  assert.throws(
    () => domain.reworkIssue(operator, issue.id, delivered.id, 'stale', accepted.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.versionConflict,
  )
  const next = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.equal(next?.issue.id, issue.id)
  assert.equal(next?.run.attempt, 2)
})

test('accepted delivery cannot be reworked while any integration may still apply', (t) => {
  for (const status of ['queued', 'integrating', 'ready', 'applying', 'applied', 'recovery_required'] as const) {
    const { domain } = openTemp(t)
    const { profile, issue } = seedBasic(domain)
    const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
    assert.ok(claim)
    const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
    const accepted = domain.acceptIssue(operator, issue.id, delivered.id, domain.getIssue(issue.id).version)
    const integration = domain.createIntegration(operator, issue.id, delivered.id, accepted.version, idem({ status }))
    if (status !== 'queued') domain.reportApplicationOutcome(operator, integration.id, { status })
    assert.throws(
      () => domain.reworkIssue(operator, issue.id, delivered.id, 'Revise', accepted.version),
      (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
      status,
    )
    assert.equal(domain.getIssue(issue.id).status, 'accepted', status)
    assert.equal(domain.getIssue(issue.id).acceptedDeliveryId, delivered.id, status)
  }
})

test('reworking an accepted fileless delivery reblocks unstarted dependents', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  const dependent = domain.createIssue(operator, {
    ...issueInput(project.id, profile.id, 'Dependent'), dependsOn: [issue.id],
  }, idem({ title: 'Dependent' }))
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, { ...delivery(), files: [] })
  const accepted = domain.acceptIssue(operator, issue.id, delivered.id, domain.getIssue(issue.id).version)
  assert.equal(domain.getIssue(dependent.id).status, 'queued')
  domain.reworkIssue(operator, issue.id, delivered.id, 'Clarify the result', accepted.version)
  assert.equal(domain.getIssue(dependent.id).status, 'blocked')
  assert.equal(domain.claimReadyIssue(workerA, { profileId: profile.id })?.issue.id, issue.id)
})

test('reworking an accepted delivery cannot invalidate a started dependent', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  const dependent = domain.createIssue(operator, {
    ...issueInput(project.id, profile.id, 'Dependent'), dependsOn: [issue.id],
  }, idem({ title: 'Dependent' }))
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, { ...delivery(), files: [] })
  const accepted = domain.acceptIssue(operator, issue.id, delivered.id, domain.getIssue(issue.id).version)
  assert.equal(domain.claimReadyIssue(workerA, { profileId: profile.id })?.issue.id, dependent.id)
  assert.throws(
    () => domain.reworkIssue(operator, issue.id, delivered.id, 'Revise', accepted.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  assert.equal(domain.getIssue(issue.id).status, 'accepted')
  assert.equal(domain.getIssue(dependent.id).status, 'starting')
})

test('workers cannot accept or score; evaluation is 1-5 and one active per issue', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const awaiting = domain.getIssue(issue.id)

  assert.throws(
    () => domain.acceptIssue(workerA, issue.id, delivered.id, awaiting.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.forbidden,
  )
  assert.throws(
    () => domain.evaluateIssue(workerA, issue.id, {
      runId: claim.run.id,
      score: 4,
      comment: 'no',
      expectedIssueVersion: awaiting.version,
    }, idem({ score: 4 })),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.forbidden,
  )
  assert.throws(
    () => domain.evaluateIssue(operator, issue.id, {
      runId: claim.run.id,
      score: 8,
      comment: 'bad',
      expectedIssueVersion: awaiting.version,
    }, idem({ score: 8 })),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
  assert.equal(domain.listEvaluations(issue.id).length, 0)

  const first = domain.evaluateIssue(operator, issue.id, {
    runId: claim.run.id,
    deliveryId: delivered.id,
    score: 3,
    comment: 'ok',
    expectedIssueVersion: awaiting.version,
  }, idem({ score: 3 }))
  const second = domain.evaluateIssue(operator, issue.id, {
    runId: claim.run.id,
    deliveryId: delivered.id,
    score: 5,
    comment: 'revised',
    expectedIssueVersion: domain.getIssue(issue.id).version,
  }, idem({ score: 5 }))
  assert.equal(first.active, true)
  assert.equal(second.active, true)
  assert.equal(second.revision, 2)
  const all = domain.listEvaluations(issue.id)
  assert.equal(all.length, 2)
  assert.equal(all[0]?.active, false)
  assert.equal(all[1]?.active, true)
  assert.equal(domain.getIssueDetail(issue.id).evaluation?.id, second.id)
})

test('evaluation cannot attribute a delivery to a different Run of the same issue', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const first = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(first)
  const firstDelivery = domain.completeRun(workerA, first.run.id, first.generation, delivery('first'))
  domain.reworkIssue(operator, issue.id, firstDelivery.id, 'revise', domain.getIssue(issue.id).version)
  const second = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(second)
  const secondDelivery = domain.completeRun(workerA, second.run.id, second.generation, delivery('second'))
  assert.throws(
    () => domain.evaluateIssue(operator, issue.id, {
      runId: first.run.id,
      deliveryId: secondDelivery.id,
      score: 4,
      comment: 'wrong Run attribution',
      expectedIssueVersion: domain.getIssue(issue.id).version,
    }, idem({ score: 4, deliveryId: secondDelivery.id })),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput,
  )
  assert.equal(domain.listEvaluations(issue.id).length, 0)
})

test('restart recovery interrupts the live run and rejects late results', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  domain.bindRun(workerA, claim.run.id, claim.generation, { sessionId: 'sess-1' })
  domain.recordRunEvent(workerA, claim.run.id, claim.generation, 'run.process_exit', { rangeExited: true })
  domain.close()

  const recovered = openDomain({ databasePath, recoverInterrupted: true })
  try {
    assert.equal(recovered.getRun(claim.run.id).run.status, 'interrupted')
    assert.equal(recovered.getIssue(issue.id).status, 'failed')
    assert.throws(
      () => recovered.completeRun(workerA, claim.run.id, claim.generation, delivery()),
      (error: unknown) => error instanceof DomainError && error.code === ErrorCode.lateResult,
    )
    assert.equal(recovered.claimReadyIssue(workerA, { profileId: profile.id }), null)
    const failed = recovered.getIssue(issue.id)
    recovered.retryIssue(operator, issue.id, failed.version)
    const next = recovered.claimReadyIssue(workerA, { profileId: profile.id })
    assert.ok(next)
    assert.equal(next.run.attempt, 2)
    assert.notEqual(next.generation, claim.generation)
  } finally {
    recovered.close()
  }
})

test('unconfirmed worker range remains fenced across service restart', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  const fenced = domain.requireRunRecovery(workerA, claim.run.id, claim.generation, 'range exit unconfirmed')
  assert.equal(fenced.status, 'recovery_required')
  const current = domain.getIssue(issue.id)
  assert.equal(current.status, 'recovery_required')
  assert.throws(
    () => domain.retryIssue(operator, issue.id, current.version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  assert.throws(
    () => domain.completeRun(workerA, claim.run.id, claim.generation, delivery('late')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.lateResult,
  )
  domain.close()
  const reopened = openDomain({ databasePath, recoverInterrupted: true })
  try {
    assert.equal(reopened.getIssue(issue.id).status, 'recovery_required')
    assert.equal(reopened.getRun(claim.run.id).run.status, 'recovery_required')
    assert.equal(reopened.getSchedulerSnapshot().activeRunCount, 1)
    assert.throws(() => reopened.retryIssue(operator, issue.id, reopened.getIssue(issue.id).version),
      (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  } finally {
    reopened.close()
  }
})

test('questions accept only the exact pending item; events use a monotonic cursor', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  const question = domain.askQuestion(workerA, claim.run.id, claim.generation, [
    { id: 'path', text: 'Which file?', required: true },
  ])
  assert.equal(domain.getIssue(issue.id).status, 'needs_input')
  assert.throws(
    () => domain.answerQuestion(operator, claim.run.id, 'missing', { path: 'a.ts' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.notFound,
  )
  const answered = domain.answerQuestion(operator, claim.run.id, question.id, { path: 'a.ts' })
  assert.ok(answered.answeredAt)
  assert.throws(
    () => domain.answerQuestion(operator, claim.run.id, question.id, { path: 'b.ts' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
  )
  assert.equal(domain.getIssue(issue.id).status, 'running')

  const first = domain.listEvents({ projectId: project.id, after: 0, limit: 2 })
  assert.equal(first.items.length, 2)
  assert.ok(first.nextCursor)
  assert.ok(first.items[0] && first.items[1] && first.items[1].sequence > first.items[0].sequence)
  const rest = domain.listEvents({ projectId: project.id, after: first.nextCursor })
  assert.ok(rest.items[0] && rest.items[0].sequence > first.items[1]!.sequence)
  const all = domain.listEvents({ projectId: project.id, after: 0, limit: 200 })
  const sequences = all.items.map((event) => event.sequence)
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b))
  assert.equal(new Set(sequences).size, sequences.length)
})

test('application prepare/apply are recorded without touching the workspace', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const awaiting = domain.getIssue(issue.id)
  const accepted = domain.acceptIssue(operator, issue.id, delivered.id, awaiting.version)
  const integrationKey = { key: 'integrate-1', body: { deliveryId: delivered.id } }
  const created = domain.createIntegration(operator, issue.id, delivered.id, accepted.version, integrationKey)
  assert.equal(created.status, 'queued')
  const replay = domain.createIntegration(operator, issue.id, delivered.id, accepted.version, integrationKey)
  assert.equal(replay.id, created.id)
  domain.reportApplicationOutcome(operator, created.id, { status: 'ready', expectedTarget: 'main' })
  const applying = domain.applyApplication(operator, created.id, 'main', idem({ apply: created.id }))
  assert.equal(applying.status, 'applying')
  const applied = domain.reportApplicationOutcome(operator, created.id, {
    status: 'applied',
    resultTarget: 'main',
    evidence: [{ kind: 'verification', label: 'apply', outcome: 'passed', detail: null }],
  })
  assert.equal(applied.status, 'applied')
  assert.equal(domain.getApplicationDetail(created.id).evidence.length, 1)
})

test('restart marks in-flight application as recovery required and rejects replay', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimReadyIssue(workerA, { profileId: profile.id })
  assert.ok(claim)
  const delivered = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const accepted = domain.acceptIssue(operator, issue.id, delivered.id, domain.getIssue(issue.id).version)
  const integration = domain.createIntegration(operator, issue.id, delivered.id, accepted.version, idem({ delivered: delivered.id }))
  domain.reportApplicationOutcome(operator, integration.id, { status: 'ready', expectedTarget: 'target' })
  domain.applyApplication(operator, integration.id, 'target', idem({ application: integration.id }))
  domain.close()
  const recovered = openDomain({ databasePath, recoverInterrupted: true })
  try {
    assert.equal(recovered.getApplication(integration.id).status, 'recovery_required')
    assert.throws(
      () => recovered.applyApplication(operator, integration.id, 'target', idem({ retry: integration.id })),
      (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict,
    )
  } finally {
    recovered.close()
  }
})
