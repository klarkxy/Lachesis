import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256Json } from '../src/util.ts'
import { openDomain } from '../src/index.ts'
import { delivery, idem, issueInput, openTemp, operator, profileInput, projectInput, workerA } from './helpers.ts'

test('claim freezes full configuration and input binds once independently of later Profile edits', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const input = { ...issueInput(project.id, profile.id, 'Analyze'), accessMode: 'read-only' as const,
    attendance: 'bounded-unattended' as const }
  const issue = domain.createIssue(operator, input, idem(input))
  const claim = domain.claimNextReadyIssue(workerA)!
  assert.equal(claim.issue.id, issue.id)
  const snapshot = claim.run.executionSnapshot!
  assert.equal(snapshot.accessMode, 'read-only')
  assert.equal(snapshot.config.modelId, 'v3')
  assert.equal(snapshot.boundaryMode, 'whole-range')
  domain.updateProfile(operator, profile.id, { modelId: 'new-model' }, profile.revision)
  assert.deepEqual(domain.getRun(claim.run.id).run.executionSnapshot, snapshot)
  const binding = { executionSnapshotDigest: sha256Json(snapshot), baseRef: 'files:baseline',
    materializedDigest: 'a'.repeat(64), captureGuarantee: 'captured-bytes' as const, boundAt: new Date().toISOString() }
  assert.throws(() => domain.bindRunInput(workerA, claim.run.id, claim.generation,
    { ...binding, executionSnapshotDigest: 'b'.repeat(64) }), /snapshot/)
  domain.bindRunInput(workerA, claim.run.id, claim.generation, binding)
  assert.throws(() => domain.bindRunInput(workerA, claim.run.id, claim.generation, binding), /already bound/)
  assert.deepEqual(domain.getRun(claim.run.id).run.inputBinding, binding)
  assert.equal(domain.listProfileRevisions(profile.id)[0]!.harnessId, profile.harnessId)
  assert.equal(domain.listProfileRevisions(profile.id)[0]!.configJson, profile.configJson)
  domain.markRunRunning(workerA, claim.run.id, claim.generation)
  assert.throws(() => domain.completeRun(workerA, claim.run.id, claim.generation, delivery()), /Read-only/)
  const report = domain.completeRun(workerA, claim.run.id, claim.generation, { ...delivery(), files: [] })
  assert.deepEqual(report.files, [])
})

test('legacy defaults remain manual write; unsupported harness and Profile ceilings do not dispatch', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, { ...profileInput(), configJson: JSON.stringify({ maxAccessMode: 'read-only' }) })
  const input = issueInput(project.id, profile.id, 'Write')
  const issue = domain.createIssue(operator, input, idem(input))
  assert.equal(issue.accessMode, 'workspace-write')
  assert.equal(issue.attendance, 'manual')
  assert.equal(domain.getDispatchDecision(issue.id).reason, 'profile_unavailable')
  assert.equal(domain.claimNextReadyIssue(workerA), null)
  const foreign = domain.createProfile(operator, { ...profileInput('Other'), harnessId: 'codex', configJson: '{}' })
  const second = { ...input, title: 'Other executor', dispatch: { mode: 'require' as const, profileId: foreign.id } }
  const other = domain.createIssue(operator, second, idem(second))
  assert.equal(domain.getDispatchDecision(other.id).reason, 'profile_unavailable')
  assert.equal(domain.claimNextReadyIssue(workerA), null)
})

test('invalid execution policy and secret or unknown DSH configuration fail before persistence', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const input = { ...issueInput(project.id, profile.id, 'Invalid'), accessMode: 'unsafe' as never }
  assert.throws(() => domain.createIssue(operator, input, idem(input)), /accessMode/)
  for (const config of [{ apiKey: 'test-only-value' }, { args: ['--unsafe'] }]) {
    assert.throws(() => domain.createProfile(operator, { ...profileInput(), configJson: JSON.stringify(config) }), /configuration field/)
  }
  assert.equal(domain.listIssues().items.length, 0)
  assert.throws(() => domain.createProfile(operator, { ...profileInput(), configJson: JSON.stringify({ boundaryMode: 'unsafe' }) }), /boundaryMode/)
  for (const config of [{ boundaryMode: ['native-tools'] }, { boundaryMode: null }, { boundaryMode: {} },
    { maxAccessMode: ['read-only'] }, { maxAttendance: ['manual'] }]) {
    assert.throws(() => domain.createProfile(operator, { ...profileInput(), configJson: JSON.stringify(config) }), /Invalid Profile/)
  }
})

test('native tool boundary freezes per Run and refuses incompatible policies before claim', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, { ...profileInput(), configJson: JSON.stringify({ boundaryMode: 'native-tools' }) })
  for (const policy of [{ accessMode: 'read-only' as const }, { isolationRequirement: 'full' as const }]) {
    const input = { ...issueInput(project.id, profile.id, JSON.stringify(policy)), ...policy }
    const issue = domain.createIssue(operator, input, idem(input))
    assert.equal(domain.getDispatchDecision(issue.id).reason, 'profile_unavailable')
    assert.deepEqual(domain.listRuns(issue.id), [])
  }
  const input = issueInput(project.id, profile.id, 'Native tools')
  domain.createIssue(operator, input, idem(input))
  const claim = domain.claimNextReadyIssue(workerA)!
  assert.equal(claim.run.executionSnapshot!.boundaryMode, 'native-tools')
  domain.updateProfile(operator, profile.id, { configJson: JSON.stringify({ boundaryMode: 'whole-range' }) }, profile.revision)
  assert.equal(domain.getRun(claim.run.id).run.executionSnapshot!.boundaryMode, 'native-tools')
  assert.equal(domain.getProjectDispatchState(project.id).environmentBlock, null)
})

test('unsupported isolation waits without a Run and does not block a supported issue', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  domain.setExecutionPolicySupport((policy) => policy.accessMode === 'read-only' || policy.requireFull ? 'Backend is partial' : null)
  const readonlyInput = { ...issueInput(project.id, profile.id, 'Inspect'), accessMode: 'read-only' as const }
  const readonlyIssue = domain.createIssue(operator, readonlyInput, idem(readonlyInput))
  const fullInput = { ...issueInput(project.id, profile.id, 'Full'), isolationRequirement: 'full' as const }
  const fullIssue = domain.createIssue(operator, fullInput, idem(fullInput))
  const writeInput = issueInput(project.id, profile.id, 'Write')
  const writeIssue = domain.createIssue(operator, writeInput, idem(writeInput))
  assert.equal(domain.getDispatchDecision(readonlyIssue.id).reason, 'profile_unavailable')
  assert.equal(domain.getDispatchDecision(fullIssue.id).reason, 'profile_unavailable')
  assert.equal(domain.claimNextReadyIssue(workerA)!.issue.id, writeIssue.id)
  assert.deepEqual(domain.listRuns(readonlyIssue.id), [])
  assert.deepEqual(domain.listRuns(fullIssue.id), [])
  assert.equal(domain.getProjectDispatchState(project.id).environmentBlock, null)
})

test('storage policy survives reopening and rejects incomplete or unsafe values', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  assert.equal(domain.getStoragePolicy(), null)
  const policy = { maxManagedBytes: 1000000, minFreeBytes: 1000, defaultRunReserveBytes: 10000,
    artifactPublishReserveBytes: 2000, maxCacheBytes: 0, executionRetentionHours: 0, checkpointRetentionDays: null }
  domain.saveStoragePolicy(operator, policy)
  assert.throws(() => domain.saveStoragePolicy(operator, { ...policy, minFreeBytes: -1 }), /minFreeBytes/)
  assert.throws(() => domain.saveStoragePolicy(operator, { ...policy, apiKey: 'not-a-secret' } as typeof policy), /storage policy/)
  domain.close()
  const reopened = openDomain({ databasePath, recoverInterrupted: false })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.getStoragePolicy(), policy)
})
