import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { rm, stat } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_RUN_SANDBOX_MODE,
  assertGrantableRoot,
  classifySandboxOutcome,
  classifySandboxVerdict,
  createDshAcpExecutor,
  runSandboxPolicy,
  runSandboxRoot,
  type RunSandboxFacts,
} from '../src/index.ts'
import { fixtureCommand, makeWorkspace, sinkEvents } from './helpers.ts'

test('the granted root is the deepest common ancestor of the workspace and the dsh home', () => {
  const root = resolve(join(tmpdir(), 'lachesis-data', 'run-1'))
  const cwd = join(root, 'work')
  const dshHome = join(root, 'dsh-home')
  assert.equal(runSandboxRoot(cwd, dshHome), root)
  // A home elsewhere forces a wider ancestor, never a narrower one.
  assert.equal(runSandboxRoot(cwd, join(resolve(tmpdir()), 'homes', 'run-1')), resolve(tmpdir()))
  // Shared prefixes on different branches must not be treated as common.
  assert.equal(runSandboxRoot(join(root, 'work'), join(root, 'workshop', 'home')), root)
})

test('a writable grant is refused for a filesystem root or the user home', () => {
  assert.throws(() => assertGrantableRoot(parse(resolve('/')).root), /filesystem root/)
  assert.throws(() => assertGrantableRoot(homedir()), /user home/)
  assert.throws(() => assertGrantableRoot(join(homedir(), '..')), /user home/)
  assert.equal(assertGrantableRoot(join(tmpdir(), 'lachesis-granted')), join(tmpdir(), 'lachesis-granted'))
})

test('the confined policy carries exactly one writable root and never full access', () => {
  const policy = runSandboxPolicy(DEFAULT_RUN_SANDBOX_MODE, join(tmpdir(), 'lachesis-policy'))
  assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: join(tmpdir(), 'lachesis-policy') })
  assert.equal('sessionId' in policy, false, 'Lachesis is not a dsh-session caller')
})

test('a denial is reported as a denial and a refused runner as a runner failure', () => {
  const facts: RunSandboxFacts = {
    mode: 'workspace-write',
    workspaceRoot: join(tmpdir(), 'lachesis-classify'),
    enforcement: 'partial',
    denialSignatures: ['EPERM: operation not permitted'],
  }
  const rules = [{ fatalSignatures: ['bwrap: refusing profile'], allowedExitCodes: [1] }]

  const denied = classifySandboxOutcome(facts, 3, 'EPERM: operation not permitted, open \'/etc/passwd\'', rules)
  assert.equal(denied?.denied, true)
  assert.equal(denied?.runnerFailed, false)
  assert.match(String(denied?.detail), /EPERM/)
  // A denial is the worker misbehaving under working confinement, never a host fault.
  assert.equal(classifySandboxVerdict(denied!), null)

  const refused = classifySandboxOutcome(facts, 1, 'bwrap: refusing profile for this root', rules)
  assert.equal(refused?.runnerFailed, true)
  assert.equal(refused?.denied, false)
  // A runner that never executed the worker is an environment fault.
  assert.equal(classifySandboxVerdict(refused!)?.code, 'sandbox_unavailable')

  // Exit status alone proves nothing in either direction.
  assert.equal(classifySandboxOutcome(facts, 3, 'ordinary application error', rules), undefined)
  assert.equal(classifySandboxOutcome(facts, null, 'EPERM: operation not permitted', rules), undefined)
  // A backend with no dialect cannot be read as either verdict.
  assert.equal(classifySandboxOutcome({ ...facts, denialSignatures: [] }, 3, 'EPERM', rules), undefined)
})

test('a Run is spawned confined, and a write outside the granted root is denied and recorded', { timeout: 60_000 }, async (t) => {
  const escapeName = '.lachesis-escape-probe.txt'
  const escapePath = join(homedir(), escapeName)
  t.after(async () => { await rm(escapePath, { force: true }) })

  const workspace = await makeWorkspace('lachesis-sandbox-')
  t.after(async () => { await workspace.cleanup() })
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  t.after(async () => { await executor.closeAll() })

  const run = await executor.start({
    cwd: workspace.cwd,
    dshHome: workspace.dshHome,
    provider: 'provider-a',
    model: 'model-a',
    command: fixtureCommand(),
    env: { LACHESIS_FIXTURE_ESCAPE: escapeName },
  })
  const events = sinkEvents(run)

  // The wrap is part of the Run's own process facts, not a preflight receipt.
  const facts = run.processFacts?.sandbox
  assert.ok(facts, 'the Run must report the sandbox it was spawned under')
  assert.equal(facts.mode, 'workspace-write')
  assert.ok(['full', 'partial'].includes(facts.enforcement), `unexpected enforcement: ${facts.enforcement}`)
  assert.equal(facts.workspaceRoot, runSandboxRoot(workspace.cwd, workspace.dshHome))
  assert.notEqual(facts.workspaceRoot, parse(facts.workspaceRoot).root, 'a Run must never be granted a filesystem root')
  assert.notEqual(facts.workspaceRoot.toLowerCase(), resolve(homedir()).toLowerCase())
  t.diagnostic(`sandboxMode=${facts.mode} enforcement=${facts.enforcement} denialSignatures=${JSON.stringify(facts.denialSignatures)}`)

  // The worker reaches for a path outside the granted root; the OS refuses it.
  const sent = run.send('ESCAPE please').then(() => undefined, (error: unknown) => error)
  const violation = await events.waitFor((event) => event.type === 'sandbox_violation', 20_000)
  assert.equal(violation.type, 'sandbox_violation')
  const verdict = violation.type === 'sandbox_violation' ? violation.verdict : undefined
  assert.equal(verdict?.denied, true, 'confinement must deny the out-of-root write')
  assert.equal(verdict?.runnerFailed, false)
  assert.equal(verdict?.mode, 'workspace-write')
  // The denied path must not exist: confinement worked rather than merely warned.
  await assert.rejects(stat(escapePath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  t.diagnostic(`send settled with: ${String((await sent) ?? 'no error')}`)

  await run.close()
  const outcome = await run.done
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.sandboxViolation?.denied, true)
  assert.match(String(outcome.error), /sandbox denied a file operation/)
})
