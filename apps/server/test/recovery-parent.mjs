import { randomUUID } from 'node:crypto'
import { LachesisApplication } from '../src/application.ts'

const [dataRoot, projectRoot] = process.argv.slice(2)
const app = await LachesisApplication.open(dataRoot)
const operator = { kind: 'operator', id: 'recovery-fixture' }
const worker = { kind: 'worker', id: 'recovery-fixture' }
const project = app.domain.createProject(operator, { name: 'Crash recovery', kind: 'files', rootPath: projectRoot })
const profile = app.domain.createProfile(operator, { name: 'Builder', avatarPresetId: 'default',
  providerRef: 'fixture', modelId: 'fixture', reasoningEffort: null })
const input = { projectId: project.id, title: 'Interrupted work', description: 'Wait for crash',
  acceptanceCriteria: ['recover'], dispatch: { mode: 'require', profileId: profile.id }, requesterRef: 'test' }
const issue = app.domain.createIssue(operator, input, { key: randomUUID(), body: input })
const claim = app.domain.claimReadyIssue(worker, { profileId: profile.id })
if (!claim) throw new Error('Could not claim recovery fixture Issue')
app.domain.markRunRunning(worker, claim.run.id, claim.generation)
process.stdout.write(JSON.stringify({ issueId: issue.id, runId: claim.run.id,
  profileId: profile.id, generation: claim.generation }) + '\n')
setInterval(() => {}, 1_000)
