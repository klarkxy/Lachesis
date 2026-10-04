import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_STORAGE_POLICY, type StorageAdmission, type StorageObservation } from '../../contracts/src/index.ts'
import { sha256Json } from '../src/util.ts'
import { delivery, idem, issueInput, openTemp, operator, profileInput, projectInput, workerA } from './helpers.ts'

test('atomic storage refusal preserves queue and attempt, and a smaller ready issue can proceed', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const issues = ['First', 'Too large', 'Small'].map((title) => {
    const input = issueInput(project.id, profile.id, title)
    return domain.createIssue(operator, input, idem(input))
  })
  const policy = { ...DEFAULT_STORAGE_POLICY, maxManagedBytes: 900 }
  domain.saveStoragePolicy(operator, policy)
  const observation: StorageObservation = { managedBytes: 100, freeBytes: 10000, runBytes: {}, observedAt: new Date().toISOString() }
  const map = new Map(issues.map((issue, index) => [issue.id, { observation, requiredBytes: [500, 1000, 200][index]!,
    sourceRef: null, policyDigest: sha256Json(policy) } satisfies StorageAdmission]))
  domain.setStorageAdmissions(map)
  assert.equal(domain.getDispatchDecision(issues[1]!.id).reason, 'storage_capacity')
  const claimA = domain.claimNextReadyIssue(workerA)!
  assert.equal(domain.listStorageReservations().length, 1)
  const claimB = domain.claimNextReadyIssue(workerA)!
  assert.deepEqual(new Set([claimA.issue.id, claimB.issue.id]), new Set([issues[0]!.id, issues[2]!.id]))
  const first = [claimA, claimB].find((claim) => claim.issue.id === issues[0]!.id)!
  assert.equal(domain.claimNextReadyIssue(workerA), null)
  assert.equal(domain.getIssue(issues[1]!.id).status, 'queued')
  assert.deepEqual(domain.listRuns(issues[1]!.id), [])

  // The first reservation's imported/copy allocation is now actual U, not still full R.
  const backend = domain.storageReservationBackend()
  backend.materialized(first.run.id, 100, 300)
  const after: StorageObservation = { managedBytes: 400, freeBytes: 9700,
    runBytes: { [first.run.id]: 300 }, observedAt: new Date().toISOString() }
  domain.setStorageAdmissions(new Map([[issues[1]!.id, { observation: after, requiredBytes: 200,
    sourceRef: null, policyDigest: sha256Json(policy) }]]))
  assert.equal(domain.getDispatchDecision(issues[1]!.id).reason, 'ready')
  assert(domain.claimNextReadyIssue(workerA))
})

test('stale measurement and changed policy do not create runs; publication and cleanup have separate receipts', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const input = issueInput(project.id, profile.id, 'Storage')
  const issue = domain.createIssue(operator, input, idem(input))
  const policy = { ...DEFAULT_STORAGE_POLICY }
  const observation = { managedBytes: 0, freeBytes: 10000, runBytes: {}, observedAt: new Date(Date.now() - 11000).toISOString() }
  domain.setStorageAdmissions(new Map([[issue.id, { observation, requiredBytes: 500, sourceRef: null,
    policyDigest: sha256Json(policy) }]]))
  assert.equal(domain.claimNextReadyIssue(workerA), null)
  assert.equal(domain.listRuns(issue.id).length, 0)
  observation.observedAt = new Date().toISOString()
  domain.saveStoragePolicy(operator, { ...policy, minFreeBytes: 100 })
  assert.equal(domain.claimNextReadyIssue(workerA), null)
  domain.setStorageAdmissions(new Map([[issue.id, { observation, requiredBytes: 500, sourceRef: null,
    policyDigest: sha256Json(domain.getStoragePolicy()) }]]))
  const claim = domain.claimNextReadyIssue(workerA)!
  const backend = domain.storageReservationBackend()
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  assert.throws(() => backend.assertCleanupAllowed(claim.run.id), /unconfirmed/)
  assert.throws(() => backend.release(claim.run.id), /unconfirmed/)
  assert.throws(() => backend.artifactReady(claim.run.id), /confirmed worker/)
  domain.recordRunEvent(workerA, claim.run.id, claim.generation, 'run.process_exit', { rangeExited: true })
  assert.throws(() => backend.assertCleanupAllowed(claim.run.id), /must be committed/)
  assert.throws(() => backend.release(claim.run.id), /must be committed/)
  backend.artifactReady(claim.run.id)
  assert.equal(backend.list()[0]!.artifactReady, true)
  assert.equal(backend.list()[0]!.published, false)
  domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  assert.doesNotThrow(() => backend.assertCleanupAllowed(claim.run.id))
  assert.equal(backend.list()[0]!.published, true)
  assert.equal(backend.list().length, 1)
  backend.release(claim.run.id)
  assert.equal(backend.list().length, 0)
})

test('unsupported retention and cache policy cannot silently appear to take effect', (t) => {
  const { domain } = openTemp(t)
  for (const patch of [{ maxCacheBytes: 1 }, { executionRetentionHours: 1 }, { checkpointRetentionDays: 1 }]) {
    assert.throws(() => domain.saveStoragePolicy(operator, { ...DEFAULT_STORAGE_POLICY, ...patch }), /unavailable/)
  }
  assert.equal(domain.getStoragePolicy(), null)
})
