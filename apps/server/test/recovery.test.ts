import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DomainError, ErrorCode } from '@lachesis/domain'
import { LachesisApplication } from '../src/application.ts'

const fixture = fileURLToPath(new URL('./recovery-parent.mjs', import.meta.url))

test('abrupt service death releases the data lease but missing range proof prevents replay after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-restart-'))
  const dataRoot = join(root, 'data')
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, dataRoot, projectRoot], {
    cwd: resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part })
  let app: LachesisApplication | undefined
  try {
    const started = await new Promise<{ issueId: string; runId: string; profileId: string; generation: number }>((done, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Recovery fixture startup timed out')), 10_000)
      child.once('error', reject)
      child.once('close', (code) => reject(new Error(`Recovery fixture exited ${code}: ${stderr}`)))
      child.stdout.setEncoding('utf8').on('data', (part: string) => {
        output += part
        const newline = output.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timeout)
        try { done(JSON.parse(output.slice(0, newline))) }
        catch (error) { reject(error) }
      })
    })
    assert.equal(child.kill('SIGKILL'), true)
    await new Promise<void>((done) => child.once('close', () => done()))
    app = await LachesisApplication.open(dataRoot)
    assert.equal(app.domain.getRun(started.runId).run.status, 'recovery_required')
    assert.equal(app.domain.getIssue(started.issueId).status, 'recovery_required')
    assert.equal(app.domain.claimReadyIssue({ kind: 'worker', id: 'new-worker' },
      { profileId: started.profileId }), null)
    assert.throws(() => app!.domain.markRunRunning({ kind: 'worker', id: 'old-worker' },
      started.runId, started.generation),
    (error) => error instanceof DomainError && error.code === ErrorCode.lateResult)
    const failed = app.domain.getIssue(started.issueId)
    assert.throws(() => app!.domain.retryIssue({ kind: 'operator', id: 'operator' }, started.issueId, failed.version))
    assert.equal(app.domain.hasConfirmedRunExit(started.runId), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((done) => child.once('close', () => done()))
    }
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
