import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DomainError, ErrorCode, openDomain } from '../src/index.ts'
import { MIGRATION_V1 } from '../src/schema.ts'
import { delivery, idem, issueInput, openTemp, operator, profileInput, projectInput, seedBasic, workerA } from './helpers.ts'

test('V1 data migrates in place, and newer schema is rejected', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lachesis-v1-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const databasePath = join(dir, 'domain.sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00Z');`)
  db.exec(MIGRATION_V1)
  db.prepare(`INSERT INTO projects (id,name,kind,root_path,created_at) VALUES ('legacy','Legacy','files','C:/legacy','2026-01-01')`).run()
  db.close()
  const domain = openDomain({ databasePath, recoverInterrupted: false })
  assert.equal(domain.schemaVersion(), 2)
  assert.equal(domain.getProject('legacy').name, 'Legacy')
  assert.equal(domain.getProjectDispatchState('legacy').paused, false)
  domain.close()
  const future = new DatabaseSync(databasePath)
  future.prepare('INSERT INTO schema_migrations VALUES (3, ?)').run('2026-01-02')
  future.close()
  assert.throws(() => openDomain({ databasePath }), (error: unknown) =>
    error instanceof DomainError && error.code === ErrorCode.conflict)
})

test('capacity, project pause, environment block and fairness use one claim decision', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { project, profile, issue } = seedBasic(domain, 'A1')
  const original = domain.getSchedulerSettings()
  domain.updateSchedulerSettings(operator, { expectedVersion: original.version, globalMaxActive: 2,
    profileLimits: { [profile.id]: 1 }, providerLimits: {} })
  const first = domain.claimNextReadyIssue(workerA)!
  assert.equal(first.issue.id, issue.id)
  const a2 = domain.createIssue(operator, issueInput(project.id, profile.id, 'A2'), idem('a2'))
  const projectB = domain.createProject(operator, projectInput('B'))
  const profileB = domain.createProfile(operator, { ...profileInput('B'), providerRef: 'other' })
  const b1 = domain.createIssue(operator, issueInput(projectB.id, profileB.id, 'B1'), idem('b1'))
  assert.equal(domain.getDispatchDecision(a2.id, profile.id).reason, 'profile_capacity')
  const second = domain.claimNextReadyIssue(workerA)!
  assert.equal(second.issue.id, b1.id)
  assert.equal(domain.getDispatchDecision(a2.id, profile.id).reason, 'global_capacity')
  assert.equal(domain.claimNextReadyIssue(workerA), null)
  assert.equal(domain.getSchedulerSnapshot().profileActiveCounts[profile.id], 1)
  domain.recordRunEvent(workerA, first.run.id, first.generation, 'run.process_exit', { rangeExited: true })
  domain.failRun(workerA, first.run.id, first.generation, 'stopped')
  const paused = domain.setProjectPaused(operator, project.id, true, domain.getProjectDispatchState(project.id).version)
  assert.equal(paused.paused, true)
  assert.equal(domain.getDispatchDecision(a2.id, profile.id).reason, 'paused')
  domain.close()
  const reopened = openDomain({ databasePath, recoverInterrupted: false })
  t.after(() => reopened.close())
  assert.equal(reopened.getProjectDispatchState(project.id).paused, true)
  reopened.setProjectPaused(operator, project.id, false, paused.version)
  reopened.blockProjectEnvironment(workerA, project.id, 'acl_denied', 'Tool sandbox cannot start')
  assert.equal(reopened.getDispatchDecision(a2.id, profile.id).reason, 'environment')
  reopened.clearProjectEnvironment(workerA, project.id, reopened.getProjectDispatchState(project.id).version)
  assert.equal(reopened.getDispatchDecision(a2.id, profile.id).reason, 'ready')
})

test('automatic dispatch rotates Profiles when both can run', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  domain.createProfile(operator, profileInput('P1'))
  domain.createProfile(operator, { ...profileInput('P2'), providerRef: 'other' })
  for (const title of ['One', 'Two']) domain.createIssue(operator,
    { ...issueInput(project.id, '', title), dispatch: { mode: 'auto', profileId: null } }, idem(title))
  const one = domain.claimNextReadyIssue(workerA)!
  const two = domain.claimNextReadyIssue(workerA)!
  assert.notEqual(one.run.profileId, two.run.profileId)
})

test('provider capacity is shared across Profiles using one route', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const firstProfile = domain.createProfile(operator, profileInput('P1'))
  const secondProfile = domain.createProfile(operator, profileInput('P2'))
  const firstIssue = domain.createIssue(operator, issueInput(project.id, firstProfile.id, 'P1 work'), idem('p1'))
  const secondIssue = domain.createIssue(operator, issueInput(project.id, secondProfile.id, 'P2 work'), idem('p2'))
  const settings = domain.getSchedulerSettings()
  domain.updateSchedulerSettings(operator, { expectedVersion: settings.version, globalMaxActive: 3,
    profileLimits: {}, providerLimits: { deepseek: 1 } })
  const claimed = domain.claimNextReadyIssue(workerA)!
  const waiting = claimed.issue.id === firstIssue.id ? secondIssue : firstIssue
  assert.equal(domain.getDispatchDecision(waiting.id).reason, 'provider_capacity')
  assert.equal(domain.getSchedulerSnapshot().providerActiveCounts.deepseek, 1)
  assert.equal(domain.claimNextReadyIssue(workerA), null)
})

test('plan scope and dependency edits gate dispatch and delivery acceptance', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue: dep } = seedBasic(domain, 'Dependency')
  const child = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Child'),
    dependsOn: [dep.id], ownedPaths: ['src/child/'], readOnlyPaths: ['src/child/generated/'] }, idem('child'))
  assert.equal(child.status, 'blocked')
  assert.deepEqual(child.ownedPaths, ['src/child/'])
  assert.throws(() => domain.updateIssuePlan(operator, dep.id, { expectedIssueVersion: dep.version, dependsOn: [child.id] }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.circularDependency)
  const edited = domain.updateIssuePlan(operator, child.id, { expectedIssueVersion: child.version,
    dependsOn: [], ownedPaths: ['src/child/'], readOnlyPaths: ['src/child/generated/'] })
  assert.equal(edited.status, 'queued')
  const claims = [domain.claimReadyIssue(workerA, { profileId: profile.id })!,
    domain.claimReadyIssue(workerA, { profileId: profile.id })!]
  assert.deepEqual(new Set(claims.map((claim) => claim.issue.id)), new Set([dep.id, child.id]))
  const childClaim = claims.find((claim) => claim.issue.id === child.id)!
  assert.equal(childClaim.issue.id, child.id)
  assert.throws(() => domain.updateIssuePlan(operator, child.id, { expectedIssueVersion: childClaim.issue.version, dependsOn: [] }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  const delivered = domain.completeRun(workerA, childClaim.run.id, childClaim.generation,
    { ...delivery(), files: [{ path: 'src/child/generated/out.ts', kind: 'added', size: 1, sha256: 'x', binary: false }] })
  assert.throws(() => domain.acceptIssue(operator, child.id, delivered.id, domain.getIssue(child.id).version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
})

test('scope syntax is literal and Windows casing cannot bypass ownership or read-only acceptance', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  for (const path of ['src/?', 'src/[a]', 'src/{a}', 'src/\0bad']) {
    assert.throws(() => domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Invalid'), ownedPaths: [path] }, idem(path)))
  }
  const issue = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Protected'),
    ownedPaths: ['src/'], readOnlyPaths: ['src/private/'] }, idem('protected'))
  const claim = domain.claimNextReadyIssue(workerA)!
  const path = process.platform === 'win32' ? 'SRC/PRIVATE/secret.ts' : 'src/private/secret.ts'
  const other = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Overlap'),
    ownedPaths: [process.platform === 'win32' ? 'SRC/public.ts' : 'src/public.ts'] }, idem('overlap'))
  assert.equal(domain.getDispatchDecision(other.id).reason, 'scope_busy')
  const candidate = domain.completeRun(workerA, claim.run.id, claim.generation, { ...delivery(),
    files: [{ path, kind: 'added', size: 1, sha256: 'x', binary: false }] })
  assert.throws(() => domain.acceptIssue(operator, issue.id, candidate.id, domain.getIssue(issue.id).version), /scope/)
})

test('actual delivery filenames allow literal brackets while rejecting unsafe relative paths', (t) => {
  const { domain } = openTemp(t)
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const paths = ['src/[slug].tsx', 'src/{route}.tsx', '../escape.ts', '/absolute.ts', 'C:/absolute.ts',
    'src\\bad.ts', 'src/\0bad.ts', 'src//bad.ts', 'src/./bad.ts', 'src/directory/']
  for (const ownedPaths of [[], ['src/']]) {
    for (const path of paths) {
      const issue = domain.createIssue(operator, { ...issueInput(project.id, profile.id, path), ownedPaths }, idem({ path, ownedPaths }))
      const claim = domain.claimNextReadyIssue(workerA)!
      assert.equal(claim.issue.id, issue.id)
      const candidate = domain.completeRun(workerA, claim.run.id, claim.generation, { ...delivery(),
        files: [{ path, kind: 'added', size: 1, sha256: 'x', binary: false }] })
      const accept = () => domain.acceptIssue(operator, issue.id, candidate.id, domain.getIssue(issue.id).version)
      if (path === paths[0] || path === paths[1]) assert.doesNotThrow(accept)
      else assert.throws(accept, (error: unknown) => error instanceof DomainError && error.code === ErrorCode.invalidInput)
    }
  }
})

test('declared overlap blocks only matching project paths; legacy empty scope stays unrestricted', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue: legacy } = seedBasic(domain)
  domain.cancelIssue(operator, legacy.id, legacy.version)
  const owned = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Owned'), ownedPaths: ['src/a/'] }, idem('owned'))
  const first = domain.claimNextReadyIssue(workerA)!
  assert.equal(first.issue.id, owned.id)
  const overlap = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Overlap'), ownedPaths: ['src/a/file.ts'] }, idem('overlap'))
  const independent = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Independent'), ownedPaths: ['src/b/'] }, idem('independent'))
  const unscoped = domain.createIssue(operator, issueInput(project.id, profile.id, 'Unscoped'), idem('unscoped'))
  assert.equal(domain.getDispatchDecision(overlap.id).reason, 'scope_busy')
  assert.equal(domain.getDispatchDecision(independent.id).reason, 'ready')
  assert.equal(domain.getDispatchDecision(unscoped.id).reason, 'ready')
  assert.ok(domain.claimNextReadyIssue(workerA))
})

test('checkpoint continuation needs recorded exit proof and never becomes a Delivery', (t) => {
  const { domain } = openTemp(t)
  const { profile, issue } = seedBasic(domain)
  const claim = domain.claimNextReadyIssue(workerA)!
  domain.failRun(workerA, claim.run.id, claim.generation, 'timed out')
  const checkpoint = { id: randomUUID(), issueId: issue.id, runId: claim.run.id, baseRef: null,
    manifestSha256: 'checkpoint-hash', files: delivery().files, reason: 'timed out' }
  assert.throws(() => domain.recordCheckpoint(workerA, checkpoint),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  domain.recordRunEvent(workerA, claim.run.id, claim.generation, 'run.process_exit', { rangeExited: true })
  const recorded = domain.recordCheckpoint(workerA, checkpoint)
  assert.equal(recorded.id, checkpoint.id)
  assert.equal(domain.listDeliveries(issue.id).length, 0)
  assert.equal(domain.getIssueDetail(issue.id).checkpoints.length, 1)
  const resumed = domain.resumeCheckpoint(operator, issue.id, checkpoint.id, domain.getIssue(issue.id).version)
  assert.equal(resumed.status, 'queued')
  assert.equal(domain.getReworkSourceDelivery(issue.id), checkpoint.id)
  assert.ok(domain.claimNextReadyIssue(workerA))
  assert.equal(domain.listRuns(issue.id).length, 2)
  assert.equal(profile.id, claim.run.profileId)
})

test('repreparation creates a fresh candidate and fences the prior ready candidate', (t) => {
  const { domain } = openTemp(t)
  const { issue } = seedBasic(domain)
  const claim = domain.claimNextReadyIssue(workerA)!
  const done = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const issueVersion = domain.acceptIssue(operator, issue.id, done.id, domain.getIssue(issue.id).version).version
  const first = domain.createIntegration(operator, issue.id, done.id, issueVersion, idem('first'))
  domain.reportApplicationOutcome(workerA, first.id, { status: 'ready' })
  const second = domain.createIntegration(operator, issue.id, done.id, issueVersion, idem('second'))
  assert.notEqual(first.id, second.id)
  assert.equal(domain.getApplication(first.id).status, 'failed')
  assert.equal(domain.getApplication(second.id).status, 'queued')
  assert.throws(() => domain.applyApplication(operator, first.id, null, idem('old')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
})

test('queued preparation restarts as failed and cannot receive a late outcome', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { issue } = seedBasic(domain)
  const claim = domain.claimNextReadyIssue(workerA)!
  const done = domain.completeRun(workerA, claim.run.id, claim.generation, delivery())
  const accepted = domain.acceptIssue(operator, issue.id, done.id, domain.getIssue(issue.id).version)
  const queued = domain.createIntegration(operator, issue.id, done.id, accepted.version, idem('queued'))
  domain.close()
  const reopened = openDomain({ databasePath, recoverInterrupted: true })
  t.after(() => reopened.close())
  assert.equal(reopened.getApplication(queued.id).status, 'failed')
  assert.match(reopened.getApplication(queued.id).diagnostic ?? '', /had not begun/i)
  assert.throws(() => reopened.reportApplicationOutcome(workerA, queued.id, { status: 'ready' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  assert.equal(reopened.createIntegration(operator, issue.id, done.id, accepted.version, idem('replacement')).status, 'queued')
})

test('integrating crash fences the project target across issues until recovery', (t) => {
  const { domain, databasePath } = openTemp(t, false)
  const { project, profile, issue: one } = seedBasic(domain, 'One')
  const two = domain.createIssue(operator, issueInput(project.id, profile.id, 'Two'), idem('two'))
  const claims = [domain.claimNextReadyIssue(workerA)!, domain.claimNextReadyIssue(workerA)!]
  const first = claims.find((claim) => claim.issue.id === one.id)!
  const second = claims.find((claim) => claim.issue.id === two.id)!
  const firstDelivery = domain.completeRun(workerA, first.run.id, first.generation, delivery('first'))
  const secondDelivery = domain.completeRun(workerA, second.run.id, second.generation, delivery('second'))
  const acceptedOne = domain.acceptIssue(operator, one.id, firstDelivery.id, domain.getIssue(one.id).version)
  const acceptedTwo = domain.acceptIssue(operator, two.id, secondDelivery.id, domain.getIssue(two.id).version)
  const candidateOne = domain.createIntegration(operator, one.id, firstDelivery.id, acceptedOne.version, idem('candidate-one'))
  const candidateTwo = domain.createIntegration(operator, two.id, secondDelivery.id, acceptedTwo.version, idem('candidate-two'))
  domain.reportApplicationOutcome(workerA, candidateOne.id, { status: 'integrating' })
  domain.reportApplicationOutcome(workerA, candidateTwo.id, { status: 'ready' })
  domain.close()
  const reopened = openDomain({ databasePath, recoverInterrupted: true })
  t.after(() => reopened.close())
  assert.equal(reopened.getApplication(candidateOne.id).status, 'recovery_required')
  assert.equal(reopened.getApplication(candidateTwo.id).status, 'ready')
  assert.throws(() => reopened.applyApplication(operator, candidateTwo.id, 'main', idem('apply-two')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  assert.throws(() => reopened.createIntegration(operator, two.id, secondDelivery.id, acceptedTwo.version, idem('reprepare-two')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  assert.throws(() => reopened.reportApplicationOutcome(workerA, candidateOne.id, { status: 'failed' }),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  const three = reopened.createIssue(operator, issueInput(project.id, profile.id, 'Three'), idem('three'))
  assert.equal(reopened.getDispatchDecision(three.id).reason, 'recovery')
  assert.equal(reopened.claimNextReadyIssue(workerA), null)
})

test('only the current accepted in-scope delivery may become an integration candidate', (t) => {
  const { domain } = openTemp(t)
  const { project, profile, issue: seed } = seedBasic(domain)
  domain.cancelIssue(operator, seed.id, seed.version)
  const issue = domain.createIssue(operator, { ...issueInput(project.id, profile.id, 'Scoped'),
    ownedPaths: ['src/allowed/'] }, idem('scoped'))
  const scoped = domain.claimReadyIssue(workerA, { profileId: profile.id })!
  const outside = domain.completeRun(workerA, scoped.run.id, scoped.generation, { ...delivery('outside'),
    files: [{ path: 'src/forbidden.ts', kind: 'added', size: 1, sha256: 'outside', binary: false }] })
  assert.throws(() => domain.acceptIssue(operator, issue.id, outside.id, domain.getIssue(issue.id).version),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  domain.reworkIssue(operator, issue.id, outside.id, 'Use the assigned path', domain.getIssue(issue.id).version)
  const next = domain.claimReadyIssue(workerA, { profileId: profile.id })!
  assert.equal(next.issue.id, issue.id)
  const inside = domain.completeRun(workerA, next.run.id, next.generation, { ...delivery('inside'),
    files: [{ path: 'src/allowed/file.ts', kind: 'added', size: 1, sha256: 'inside', binary: false }] })
  const accepted = domain.acceptIssue(operator, issue.id, inside.id, domain.getIssue(issue.id).version)
  assert.throws(() => domain.createIntegration(operator, issue.id, outside.id, accepted.version, idem('old-outside')),
    (error: unknown) => error instanceof DomainError && error.code === ErrorCode.conflict)
  const candidate = domain.createIntegration(operator, issue.id, inside.id, accepted.version, idem('current-inside'))
  domain.reportApplicationOutcome(workerA, candidate.id, { status: 'ready', expectedTarget: 'main' })
  assert.equal(domain.applyApplication(operator, candidate.id, 'main', idem('apply-current')).status, 'applying')
})
