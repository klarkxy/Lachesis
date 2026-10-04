import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDomain } from '@lachesis/plugin-domain'
import { Workspace } from '@lachesis/plugin-workspace'
import { RunSupervisor } from '../src/supervisor.ts'

test('readiness preparation failure releases its confirmed operation without starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lachesis-readiness-storage-'))
  const projectRoot = join(root, 'target')
  const dataRoot = join(root, 'data')
  await mkdir(projectRoot)
  await mkdir(dataRoot)
  const domain = openDomain({ databasePath: join(dataRoot, 'domain.sqlite') })
  const workspace = new Workspace({ storeRoot: join(dataRoot, 'artifacts') })
  const supervisor = new RunSupervisor(domain, workspace, dataRoot, {
    async start() { throw new Error('must not start a worker') },
    async closeAll() {},
  })
  try {
    const project = domain.createProject({ kind: 'operator', id: 'test' }, {
      name: 'Probe', kind: 'files', rootPath: projectRoot, targetBranch: 'main',
    })
    workspace.prepareRun = async () => { throw new Error('injected preparation failure') }
    await assert.rejects(supervisor.checkProjectReadiness(project.id,
      domain.getProjectDispatchState(project.id).version), /injected preparation failure/)
    assert.deepEqual(domain.listStorageReservations(), [])
  } finally {
    await supervisor.stop()
    domain.close()
    await rm(root, { recursive: true, force: true })
  }
})
