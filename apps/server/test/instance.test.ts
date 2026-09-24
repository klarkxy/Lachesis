import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Service } from '@deepseek-ai/cordis'
import { LachesisApplication } from '../src/application.ts'
import LachesisServer from '../src/plugin.ts'

const contender = fileURLToPath(new URL('./instance-contender.mjs', import.meta.url))

async function contend(dataRoot: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', contender, dataRoot], {
    cwd: resolve(import.meta.dirname, '../../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part })
  child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

test('a second process cannot open the same canonical data root or recover the first live Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-singleton-'))
  const dataRoot = join(root, 'data')
  const app = await LachesisApplication.open(dataRoot)
  try {
    const operator = { kind: 'operator' as const, id: 'operator' }
    const worker = { kind: 'worker' as const, id: 'worker' }
    const project = app.domain.createProject(operator, { name: 'Fixture', kind: 'files', rootPath: root })
    const profile = app.domain.createProfile(operator, { name: 'Builder', avatarPresetId: 'default',
      providerRef: 'fake', modelId: 'fake', reasoningEffort: null })
    const issueInput = { projectId: project.id, title: 'Pending work', description: 'Wait',
      acceptanceCriteria: ['done'], dispatch: { mode: 'require' as const, profileId: profile.id }, requesterRef: 'test' }
    const issue = app.domain.createIssue(operator, issueInput, { key: randomUUID(), body: issueInput })
    const claim = app.domain.claimReadyIssue(worker, { profileId: profile.id })
    assert.ok(claim)
    assert.equal(app.domain.getRun(claim.run.id).run.status, 'starting')

    const alias = process.platform === 'win32'
      ? resolve(dataRoot, '..', basename(dataRoot).toUpperCase())
      : dataRoot
    const second = await contend(alias)
    assert.equal(second.code, 42, second.stderr)
    assert.match(second.stderr, /data directory is already in use/)
    assert.equal(app.domain.getRun(claim.run.id).run.status, 'starting')
    assert.equal(app.domain.getIssue(issue.id).status, 'starting')
    assert.equal(existsSync(join(dataRoot, 'auth.json')), false)
  } finally {
    await app.close()
  }
  try {
    const afterRelease = await contend(dataRoot)
    assert.equal(afterRelease.code, 0, afterRelease.stderr)
    assert.match(afterRelease.stdout, /acquired/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('plugin initialization failure closes the database and releases the data-root lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-start-fail-'))
  const dataRoot = join(root, 'data')
  const seeded = await LachesisApplication.open(dataRoot)
  await seeded.close()
  await writeFile(join(dataRoot, 'auth.json'), '{invalid')
  const plugin = Object.create(LachesisServer.prototype) as LachesisServer
  Reflect.set(plugin, 'ctx', { logger: { error() {} } })
  Reflect.set(plugin, 'config', { dataRoot, staticRoot: root })
  try {
    await assert.rejects(plugin[Service.init](), SyntaxError)
    const afterFailure = await contend(dataRoot)
    assert.equal(afterFailure.code, 0, afterFailure.stderr)
    assert.match(afterFailure.stdout, /acquired/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
