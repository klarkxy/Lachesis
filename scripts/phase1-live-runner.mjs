import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { LachesisApplication } from '../apps/server/dist/application.js'
import { liveTickets, projectSpec } from './phase1-live-spec.mjs'

const exec = promisify(execFile)
const root = resolve(process.argv[2] || `.lachesis/phase1-live-${Date.now()}`)
const dataRoot = join(root, 'data')
const target = join(root, 'target')
const reportPath = join(root, 'result.json')
const actor = { kind: 'browser', id: 'phase1-operator', projectIds: null, permissions: null }
if (!process.env.OCG_GATEWAY_KEY) throw new Error('Gateway credential must be provided privately to the test process')
await mkdir(join(dataRoot, 'dsh'), { recursive: true })
await mkdir(target, { recursive: true })
await writeFile(join(target, 'SPEC.md'), projectSpec)
await writeFile(join(dataRoot, 'dsh', 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      local-ocg:
        displayName: Local OCG
        api: openai-completions
        apiKeyEnv: OCG_GATEWAY_KEY
        baseURL: http://127.0.0.1:19042/v1
        models:
          - id: mimo-v2.6-flash
            name: MiMo Flash
            contextWindow: 200000
          - id: mimo-v2.6-pro
            name: MiMo Pro
            contextWindow: 200000
`)
const app = await LachesisApplication.open(dataRoot)
const invoke = (operation, input, idempotencyKey = null) => app.invoke(operation, input, { actor, idempotencyKey })
const receipt = { root, dataRoot, target, startedAt: new Date().toISOString(), dshVersion: '0.1.7-alpha.2',
  models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], issues: [], transitions: [], peakActiveRuns: 0, peakRunningRuns: 0,
  successfulApplications: 0, result: 'running' }
const transitions = new Map()
const done = new Set()
const initialTarget = await readFile(join(target, 'SPEC.md'), 'utf8')
function redact(text) { return String(text).replaceAll(process.env.OCG_GATEWAY_KEY, '[redacted]') }
async function save() { await writeFile(reportPath, JSON.stringify(receipt, null, 2)) }
function runEvents(runId) {
  const items = []
  let after = 0
  while (items.length < 10000) {
    const page = app.domain.listEvents({ runId, after, limit: 200 })
    items.push(...page.items)
    if (!page.nextCursor) break
    after = Number(page.nextCursor)
  }
  return items
}
try {
  const verificationCommand = `"${process.execPath.replaceAll('\\', '/')}" "${fileURLToPath(new URL('./phase1-project-check.mjs', import.meta.url)).replaceAll('\\', '/')}"`
  const project = await invoke('project.create', { name: 'Phase 1 offline reading list', kind: 'files', rootPath: target, verificationCommand })
  receipt.projectId = project.id
  const settings = await invoke('scheduler.get', {})
  await invoke('scheduler.update', { globalMaxActive: 4, profileLimits: {}, providerLimits: {}, expectedVersion: settings.settings.version })
  const profiles = {}
  for (const modelId of receipt.models) profiles[modelId] = await invoke('profile.create', {
    name: modelId, avatarPresetId: 'default', providerRef: 'local-ocg', modelId, reasoningEffort: null,
    configJson: JSON.stringify({ boundaryMode: 'native-tools' }),
  })
  const ids = new Map()
  for (const ticket of liveTickets) {
    const modelId = ['model', 'shell', 'tests'].includes(ticket.key) ? 'mimo-v2.6-pro' : 'mimo-v2.6-flash'
    const issue = await invoke('issue.create', { projectId: project.id, title: ticket.title,
      description: `${ticket.request}\nRead SPEC.md and existing modules. Write ONLY: ${ticket.paths.join(', ')}. Preserve all other files. Do not initialize or modify Git. Report checks and any discovered problems honestly.`,
      acceptanceCriteria: [`实现 SPEC.md 对应能力；仅修改 ${ticket.paths.join(', ')}`, '相关真实检查通过；记录实际结果'],
      dispatch: { mode: 'require', profileId: profiles[modelId].id }, dependsOn: ticket.deps.map((key) => ids.get(key)),
      ownedPaths: ticket.paths, readOnlyPaths: ['SPEC.md'], accessMode: 'workspace-write', attendance: 'bounded-unattended',
      isolationRequirement: 'trusted-host', requesterRef: 'phase1-live', clientRequestId: `phase1-${ticket.key}`,
    }, `create-${ticket.key}-${randomUUID()}`)
    ids.set(ticket.key, issue.id)
    receipt.issues.push({ key: ticket.key, id: issue.id, paths: ticket.paths, modelId, dependsOn: ticket.deps, status: issue.status })
  }
  // All queued rows exist before dispatch. They must not already own materialized directories.
  assert.equal(app.domain.getSchedulerSnapshot(project.id).activeRunCount, 0)
  await save()
  console.log(JSON.stringify({ step: 'created', root, projectId: project.id, tickets: receipt.issues.length }))
  app.start()
  const deadline = Date.now() + 45 * 60_000
  while (done.size < liveTickets.length && Date.now() < deadline) {
    const snapshot = app.domain.getSchedulerSnapshot(project.id)
    receipt.peakActiveRuns = Math.max(receipt.peakActiveRuns, snapshot.activeRunCount)
    const running = receipt.issues.filter((item) => app.domain.listRuns(item.id).at(-1)?.status === 'running').length
    receipt.peakRunningRuns = Math.max(receipt.peakRunningRuns, running)
    if (snapshot.projects[0]?.environmentBlock) throw new Error(`Environment blocked: ${snapshot.projects[0].environmentBlock.code}: ${snapshot.projects[0].environmentBlock.diagnostic}`)
    for (const item of receipt.issues) {
      if (done.has(item.id)) continue
      const detail = await invoke('issue.get', { issueId: item.id })
      const issue = detail.issue
      if (transitions.get(issue.id) !== issue.status) {
        transitions.set(issue.id, issue.status)
        item.status = issue.status
        const event = { at: new Date().toISOString(), key: item.key, status: issue.status, runId: issue.currentRunId }
        receipt.transitions.push(event)
        console.log(JSON.stringify(event))
      }
      if (issue.status === 'needs_input') throw new Error(`${item.key} unexpectedly requested manual input`)
      if (['failed', 'cancelled', 'recovery_required'].includes(issue.status)) {
        item.events = issue.currentRunId ? runEvents(issue.currentRunId)
          .filter((event) => /failed|environment|recovery|exit/.test(event.type))
          .map(({ type, data }) => ({ type, data: JSON.parse(redact(JSON.stringify(data))) })) : []
        throw new Error(`${item.key} reached ${issue.status}`)
      }
      if (issue.status !== 'awaiting_review') continue
      const delivery = detail.deliveries.at(-1)
      assert(delivery, 'Review must have immutable delivery')
      item.deliveryId = delivery.id
      item.runId = delivery.runId
      item.files = delivery.files.map(({ path, kind, sha256 }) => ({ path, kind, sha256 }))
      assert(delivery.files.every((file) => item.paths.includes(file.path)), 'Delivery exceeded its owned paths')
      assert(delivery.files.length > 0, 'Task completed without its promised files')
      const run = (await invoke('run.get', { runId: delivery.runId })).run
      assert(run.executionSnapshot && run.inputBinding, 'Execution must record frozen configuration and bound input')
      assert.equal(run.executionSnapshot.boundaryMode, 'native-tools')
      item.inputBinding = run.inputBinding
      const events = runEvents(run.id)
      item.processFacts = events.find(event => event.type === 'run.process_facts')?.data ?? null
      assert(item.processFacts?.sandbox, 'Native process must report its actual sandbox wrap')
      assert.equal(item.processFacts.sandbox.workspaceRoot, join(dataRoot, 'execution', run.id, 'box'))
      assert.equal(item.processFacts.sandbox.boundaryMode, 'native-tools')
      assert.equal(item.processFacts.sandbox.harnessEnforcement, 'trusted-host')
      assert.equal(item.processFacts.sandbox.toolWorkspaceRoot, run.workspacePath)
      assert.equal(item.processFacts.sandbox.tempRoot, join(dataRoot, 'execution', run.id, 'tmp'))
      assert(/^[a-f0-9]{64}$/.test(run.inputBinding.harnessConfigDigest), 'Private provider config was not bound')
      item.promptStartedAt = events.find((event) => event.type === 'run.state' && event.data?.state === 'prompting')?.createdAt ?? null
      item.promptEndedAt = events.find((event) => event.type === 'run.prompt_ended')?.createdAt ?? null
      // Verify artifact retrieval after the successful worker workspace was released.
      let workPresent = true
      try { await stat(run.workspacePath) } catch (e) { if (e.code === 'ENOENT') workPresent = false; else throw e }
      item.workPresentAtReview = workPresent
      for (const file of delivery.files.filter((file) => file.kind !== 'deleted')) {
        const bytes = await app.readDeliveryFile(actor, delivery.id, file.path)
        assert.equal(bytes.bytes.length, file.size)
      }
      const accepted = await invoke('issue.accept', { issueId: issue.id, deliveryId: delivery.id, expectedIssueVersion: issue.version })
      const candidate = await invoke('application.prepare', { issueId: issue.id, deliveryId: delivery.id,
        expectedIssueVersion: accepted.version }, `prepare-${issue.id}`)
      item.verification = await app.supervisor.workspace.readVerification(candidate.id)
      assert.equal(candidate.status, 'ready', candidate.diagnostic)
      const applied = await invoke('application.apply', { applicationId: candidate.id,
        expectedTarget: candidate.expectedTarget }, `apply-${candidate.id}`)
      assert.equal(applied.status, 'applied', applied.diagnostic)
      item.applicationId = applied.id
      item.status = 'applied'
      receipt.successfulApplications++
      done.add(issue.id)
      console.log(JSON.stringify({ step: 'applied', key: item.key, files: item.files.map((file) => file.path), workPresent }))
    }
    await save()
    if (done.size < liveTickets.length) await new Promise((resolve) => setTimeout(resolve, 800))
  }
  assert.equal(done.size, liveTickets.length, 'Ten-ticket experiment timed out')
  assert(receipt.peakActiveRuns >= 2, 'Experiment never observed parallel active Runs')
  const overlapping = receipt.issues.flatMap((left, index) => receipt.issues.slice(index + 1).filter((right) =>
    left.promptStartedAt && left.promptEndedAt && right.promptStartedAt && right.promptEndedAt &&
    Date.parse(left.promptStartedAt) < Date.parse(right.promptEndedAt) &&
    Date.parse(right.promptStartedAt) < Date.parse(left.promptEndedAt)
  ).map((right) => [left.key, right.key]))
  receipt.overlappingPrompts = overlapping
  assert(overlapping.length > 0, 'No actual overlapping prompt intervals were recorded')
  for (const item of receipt.issues) {
    const run = app.domain.getRun(item.runId).run
    let exists = true
    for (let retry = 0; retry < 20; retry++) {
      try { await stat(run.workspacePath) } catch (e) { if (e.code === 'ENOENT') { exists = false; break } throw e }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(exists, false, `Successful ${item.key} execution directory was retained`)
    item.cleanedAtFinalCheck = true
    const file = item.files.find((file) => file.kind !== 'deleted')
    if (file) await app.readDeliveryFile(actor, item.deliveryId, file.path)
  }
  assert.equal(await readFile(join(target, 'SPEC.md'), 'utf8'), initialTarget)
  const checks = await exec(process.execPath, ['tests.mjs'], { cwd: target, timeout: 30_000 })
  receipt.finalChecks = { command: 'node tests.mjs', stdout: redact(checks.stdout).slice(0, 8000), passed: true }
  receipt.result = 'passed'
} catch (error) {
  receipt.result = 'failed'
  receipt.diagnostic = redact(error.message).slice(0, 2000)
  console.error(JSON.stringify({ step: 'failure', diagnostic: receipt.diagnostic, root }))
  process.exitCode = 1
} finally {
  receipt.finishedAt = new Date().toISOString()
  await app.close().catch((error) => { receipt.shutdownError = redact(error.message); process.exitCode = 1 })
  await save()
  console.log(JSON.stringify({ step: 'finished', result: receipt.result, applications: receipt.successfulApplications,
    peakActiveRuns: receipt.peakActiveRuns, reportPath }))
}
