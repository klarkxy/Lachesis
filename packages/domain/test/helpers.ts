import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { CreateIssueInput, CreateProfileInput, CreateProjectInput } from '../../contracts/src/index.ts'
import { openDomain, type Actor, type DeliveryInput, type DomainService } from '../src/index.ts'

export const operator: Actor = { kind: 'operator', id: 'operator-1' }
export const workerA: Actor = { kind: 'worker', id: 'worker-a' }
export const workerB: Actor = { kind: 'worker', id: 'worker-b' }

export function openTemp(t: TestContext, recoverInterrupted = true): { domain: DomainService; databasePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lachesis-domain-'))
  const databasePath = join(dir, 'domain.sqlite')
  const domain = openDomain({ databasePath, recoverInterrupted })
  t.after(() => {
    try {
      domain.close()
    } catch {
      // already closed
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold the WAL sidecar briefly
    }
  })
  return { domain, databasePath }
}

export function projectInput(name = 'Demo'): CreateProjectInput {
  return { name, kind: 'files', rootPath: 'C:/tmp/lachesis-demo', targetBranch: 'main' }
}

export function profileInput(name = 'Builder'): CreateProfileInput {
  return {
    name,
    avatarPresetId: 'preset-1',
    providerRef: 'deepseek',
    modelId: 'v3',
    reasoningEffort: null,
  }
}

export function issueInput(projectId: string, profileId: string, title: string): CreateIssueInput {
  return {
    projectId,
    title,
    description: `${title} description`,
    acceptanceCriteria: ['works'],
    dispatch: { mode: 'require', profileId },
    requesterRef: 'human',
  }
}

export function idem(body: unknown) {
  return { key: randomUUID(), body }
}

export function delivery(manifestSha256 = 'sha-1'): DeliveryInput {
  return {
    summary: 'implemented',
    finalResponse: 'done',
    files: [{ path: 'src/a.ts', kind: 'added', size: 12, sha256: 'file-sha', binary: false }],
    evidence: [{ kind: 'lifecycle', label: 'prompt_ended', outcome: 'passed', detail: null }],
    manifestSha256,
  }
}

export function seedBasic(domain: DomainService, title = 'First task') {
  const project = domain.createProject(operator, projectInput())
  const profile = domain.createProfile(operator, profileInput())
  const issue = domain.createIssue(operator, issueInput(project.id, profile.id, title), idem({ title }))
  return { project, profile, issue }
}
