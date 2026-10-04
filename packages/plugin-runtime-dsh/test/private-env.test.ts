import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { ExecutionPolicyError, createDshAcpExecutor } from '../src/index.ts'
import { acpCommandFromPinnedBin, defaultAcpCommand, pinnedDshBin } from '../src/command.ts'
import { AcpRun } from '../src/run.ts'
import {
  gateConfinedWrap,
  mapAgentlessWindowsTemp,
  nativeExecutionPolicySupport,
  pinnedWindowsAclPrefix,
  privateRunEnv,
  privateTmpPath,
  resolveRunGrant,
  runSandboxRoot,
  sandboxCacheFingerprint,
} from '../src/sandbox.ts'
import { assistantText, fixtureCommand, makeWorkspace, sinkEvents } from './helpers.ts'

async function makeExecutionLayout(prefix: string): Promise<{
  root: string
  cwd: string
  home: string
  state: string
  tmp: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const cwd = join(root, 'work')
  const state = join(root, 'state')
  const home = join(state, 'home')
  const tmp = join(state, 'tmp')
  await mkdir(cwd)
  await mkdir(home, { recursive: true })
  await mkdir(tmp)
  return { root, cwd, home, state, tmp, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

async function makeBoxLayout(prefix: string): Promise<{
  execution: string
  box: string
  cwd: string
  home: string
  tmp: string
  cleanup: () => Promise<void>
}> {
  const execution = await mkdtemp(join(tmpdir(), prefix))
  const box = join(execution, 'box')
  const cwd = join(box, 'work')
  const home = join(box, 'state', 'home')
  const tmp = join(execution, 'tmp')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(tmp)
  return { execution, box, cwd, home, tmp, cleanup: async () => { await rm(execution, { recursive: true, force: true }) } }
}

test('private run env overrides profile and temp names under the provided home', async (t) => {
  const layout = await makeExecutionLayout('lachesis-private-env-')
  t.after(layout.cleanup)
  const env = await privateRunEnv({ dshHome: layout.home })
  assert.equal(env.DSH_HOME, resolve(layout.home))
  assert.equal(env.HOME, env.DSH_HOME)
  assert.equal(env.USERPROFILE, env.DSH_HOME)
  assert.equal(env.TMP, resolve(layout.tmp))
  assert.equal(env.TEMP, env.TMP)
  assert.equal(env.TMPDIR, env.TMP)
  assert.equal(privateTmpPath(layout.home), env.TMP)
  assert.equal(env.APPDATA, join(env.HOME, 'AppData', 'Roaming'))
  assert.equal(env.LOCALAPPDATA, join(env.HOME, 'AppData', 'Local'))
  assert.equal(env.XDG_CONFIG_HOME, join(env.HOME, '.config'))
  assert.equal(env.XDG_CACHE_HOME, join(env.HOME, '.cache'))
  assert.equal(env.XDG_DATA_HOME, join(env.HOME, '.local', 'share'))
  assert.equal(env.XDG_STATE_HOME, join(env.HOME, '.local', 'state'))
  const drive = parse(env.HOME).root
  if (/^[A-Za-z]:\\$/.test(drive)) assert.equal(env.HOMEDRIVE, drive.slice(0, 2))
  for (const path of [env.TMP, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME]) {
    const info = await lstat(path)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(info.isDirectory(), true)
  }
})

test('the default ACP command is the pinned package runtime, never PATH dsh', () => {
  assert.throws(() => acpCommandFromPinnedBin(pinnedDshBin(), false), /PATH dsh fallback/)
  const command = defaultAcpCommand()
  assert.equal(command[0], process.execPath)
  assert.equal(command[1], pinnedDshBin())
  assert.deepEqual(command.slice(2), ['--profile', 'acp'])
})

test('an explicit root is used as itself and a wider ancestor is refused', async (t) => {
  const layout = await makeExecutionLayout('lachesis-explicit-root-')
  t.after(layout.cleanup)
  const write = await resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { mode: 'workspace-write', workspaceRoot: layout.root, accessMode: 'workspace-write', requireFull: false },
  })
  assert.equal(write.explicit, true)
  assert.equal(write.workspaceRoot, resolve(layout.root))
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { workspaceRoot: dirname(layout.root), accessMode: 'workspace-write', requireFull: false },
  }), /common ancestor/)
  const readOnly = await resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { mode: 'workspace-write', workspaceRoot: layout.state, accessMode: 'read-only', requireFull: false },
  })
  assert.equal(readOnly.workspaceRoot, resolve(layout.state))
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { workspaceRoot: layout.root, accessMode: 'read-only', requireFull: false },
  }), /common ancestor/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { workspaceRoot: parse(layout.root).root, accessMode: 'workspace-write', requireFull: false },
  }), /filesystem root/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { workspaceRoot: homedir(), accessMode: 'workspace-write', requireFull: false },
  }), /user home/)
})

test('omitted sandbox keeps the common-ancestor fallback for custom fixtures', async (t) => {
  const workspace = await makeWorkspace('lachesis-legacy-root-')
  t.after(workspace.cleanup)
  const grant = await resolveRunGrant(workspace)
  assert.equal(grant.explicit, false)
  assert.equal(grant.workspaceRoot, runSandboxRoot(workspace.cwd, workspace.dshHome))
})

test('an explicit temp sibling stays outside the cwd and home grant', async (t) => {
  const layout = await makeBoxLayout('lachesis-box-')
  t.after(layout.cleanup)
  const sandbox = {
    mode: 'workspace-write' as const,
    workspaceRoot: layout.box,
    tempRoot: layout.tmp,
    accessMode: 'workspace-write' as const,
    requireFull: false,
  }
  const grant = await resolveRunGrant({ cwd: layout.cwd, dshHome: layout.home, sandbox })
  assert.equal(grant.workspaceRoot, resolve(layout.box))
  assert.equal(grant.tempRoot, resolve(layout.tmp))
  assert.notEqual(grant.workspaceRoot.toLowerCase(), resolve(layout.execution).toLowerCase())
  const env = await privateRunEnv({ dshHome: layout.home, workspaceRoot: layout.box, tempRoot: layout.tmp })
  assert.equal(env.TMP, resolve(layout.tmp))
  assert.equal(env.TEMP, env.TMP)
  assert.equal(env.TMPDIR, env.TMP)
  assert.notDeepEqual(
    sandboxCacheFingerprint(sandbox),
    sandboxCacheFingerprint({ workspaceRoot: layout.box, accessMode: 'workspace-write', requireFull: false }),
  )
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { ...sandbox, workspaceRoot: layout.execution },
  }), /tmp sibling/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { ...sandbox, tempRoot: join(layout.box, 'state', 'tmp') },
  }), /tmp sibling/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { accessMode: 'workspace-write', requireFull: false, tempRoot: layout.tmp },
  }), /explicit workspaceRoot/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { ...sandbox, tempRoot: parse(layout.box).root },
  }), /filesystem root/)
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { ...sandbox, tempRoot: homedir() },
  }), /user home/)
})

test('agentless windows temp maps onto the private base and sessionful argv is refused', () => {
  const prefix = pinnedWindowsAclPrefix()
  const box = join(tmpdir(), 'lachesis-map-box')
  const temp = join(tmpdir(), 'lachesis-map-tmp')
  const policy = { mode: 'workspace-write' as const, workspaceRoot: box }
  const command = ['node', 'agent.mjs']
  const mapped = mapAgentlessWindowsTemp(
    [...prefix, '--workspace', box, '--temp', tmpdir(), '--mode', 'workspace-write', '--', ...command],
    policy,
    temp,
  )
  assert.equal(mapped[prefix.length + 3], temp)
  assert.deepEqual(mapped.slice(prefix.length + 6), ['--', ...command])
  assert.notEqual(mapped[prefix.length + 3].toLowerCase(), resolve(tmpdir()).toLowerCase())
  assert.throws(() => mapAgentlessWindowsTemp(
    [...prefix, '--workspace', box, '--temp', tmpdir(), '--mode', 'workspace-write', '--write-sid', 'S-1', '--temp-write-sid', 'S-2', '--', ...command],
    policy,
    temp,
  ), /Sessionful/)
  assert.throws(() => mapAgentlessWindowsTemp(
    ['node', 'not-the-runner', '--workspace', box, '--temp', tmpdir(), '--mode', 'workspace-write', '--', 'x'],
    policy,
    temp,
  ), /unrecognized/)
  assert.throws(() => mapAgentlessWindowsTemp(
    [...prefix, '--workspace', dirname(box), '--temp', tmpdir(), '--mode', 'workspace-write', '--', ...command],
    policy,
    temp,
  ), /unrecognized/)
})

test('the pinned command rejects a missing workspaceRoot before spawn', async (t) => {
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  t.after(() => executor.closeAll())
  await assert.rejects(() => executor.start({
    cwd: join(tmpdir(), 'lachesis-unrooted-cwd'),
    dshHome: join(tmpdir(), 'lachesis-unrooted-home'),
    provider: 'p',
    model: 'm',
  }), /explicit workspaceRoot/)
})

test('a linked sandbox root is refused', async (t) => {
  const layout = await makeExecutionLayout('lachesis-linked-root-')
  t.after(layout.cleanup)
  const linked = join(tmpdir(), `lachesis-link-${Date.now()}`)
  try {
    await symlink(layout.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('this host cannot create a directory junction')
      return
    }
    throw error
  }
  t.after(async () => { await rm(linked, { force: true }) })
  await assert.rejects(() => resolveRunGrant({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: { workspaceRoot: linked, accessMode: 'workspace-write', requireFull: false },
  }), /linked/)
})

test('windows policy matches the installed partial windows-acl backend', async () => {
  const source = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-local')), 'utf8')
  assert.match(source, /win32:\s*\["windows-acl"\]/)
  assert.match(source, /"windows-acl":\s*"partial"/)
  assert.match(source, /darwin:\s*\["seatbelt"\]/)
  assert.match(source, /seatbelt:\s*"full"/)
  assert.match(source, /linux:\s*\["bwrap",\s*"landlock"\]/)
  const readOnly = nativeExecutionPolicySupport({ accessMode: 'read-only', requireFull: false }, 'win32')
  const full = nativeExecutionPolicySupport({ accessMode: 'workspace-write', requireFull: true }, 'win32')
  const write = nativeExecutionPolicySupport({ accessMode: 'workspace-write', requireFull: false }, 'win32')
  assert.equal(readOnly.supported, false)
  assert.match(readOnly.diagnostic ?? '', /windows-acl/)
  assert.match(readOnly.diagnostic ?? '', /partial/)
  assert.equal(full.supported, false)
  assert.match(full.diagnostic ?? '', /partial/)
  assert.equal(write.supported, true)
  assert.equal(write.diagnostic, null)
  assert.equal(nativeExecutionPolicySupport({ accessMode: 'read-only', requireFull: false }, 'linux').supported, false)
  assert.equal(nativeExecutionPolicySupport({ accessMode: 'workspace-write', requireFull: true }, 'linux').supported, true)
  assert.equal(nativeExecutionPolicySupport({ accessMode: 'workspace-write', requireFull: false }, 'darwin').supported, true)
})

test('fake full wraps proceed and partial or unknown wraps are refused', async () => {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: join(tmpdir(), 'lachesis-wrap') }
  const request = { mode: 'workspace-write' as const, accessMode: 'workspace-write' as const, requireFull: true }
  let calls = 0
  const wrapped = async (enforcement: 'full' | 'partial' | 'unknown') => gateConfinedWrap(request, ['bin'], policy, async () => {
    calls++
    return {
      argv: ['wrapped'],
      enforcement: enforcement === 'unknown' ? 'unknown' as 'full' : enforcement,
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }, 'linux')
  assert.equal((await wrapped('full')).argv[0], 'wrapped')
  await assert.rejects(() => wrapped('partial'), /Partial sandbox enforcement/)
  await assert.rejects(() => wrapped('unknown'), /Unknown sandbox enforcement/)
  assert.equal(calls, 3)
  await assert.rejects(() => gateConfinedWrap(
    { mode: 'workspace-write', accessMode: 'read-only', requireFull: false },
    ['bin'], policy, async () => { calls++; throw new Error('should not confine') }, 'win32',
  ), /windows-acl/)
  await assert.rejects(() => gateConfinedWrap(
    { mode: 'workspace-write', accessMode: 'workspace-write', requireFull: true },
    ['bin'], policy, async () => { calls++; throw new Error('should not confine') }, 'win32',
  ), /windows-acl/)
  assert.equal(calls, 3)
})

test('read-only, full, and a widened root never spawn', async (t) => {
  const layout = await makeExecutionLayout('lachesis-no-spawn-')
  t.after(layout.cleanup)
  const cases = [
    { accessMode: 'read-only' as const, requireFull: false, workspaceRoot: layout.state },
    { accessMode: 'workspace-write' as const, requireFull: true, workspaceRoot: layout.root },
    { accessMode: 'workspace-write' as const, requireFull: false, workspaceRoot: dirname(layout.root) },
  ]
  for (const sandbox of cases) {
    let confine = 0
    let spawn = 0
    const run = new AcpRun({
      cwd: layout.cwd,
      dshHome: layout.home,
      provider: 'p',
      model: 'm',
      command: fixtureCommand(),
      env: { HOME: homedir(), DSH_HOME: join(homedir(), '.dsh') },
      sandbox: { mode: 'workspace-write', ...sandbox },
    }, {
      host: {
        subprocess: {},
        confine: async () => {
          confine++
          return { argv: ['wrapped'], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }
        },
        spawn: () => { spawn++; throw new Error('spawned') },
      } as never,
      onClosed: () => {},
    })
    await assert.rejects(() => run.activate(), ExecutionPolicyError)
    assert.equal(spawn, 0)
    if (!nativeExecutionPolicySupport({ accessMode: sandbox.accessMode, requireFull: sandbox.requireFull }).supported) {
      assert.equal(confine, 0)
    }
  }
})

test('spawn env overrides ambient profile names and keeps the explicit root', async (t) => {
  const layout = await makeExecutionLayout('lachesis-spawn-env-')
  t.after(layout.cleanup)
  let root = ''
  let env: NodeJS.ProcessEnv | undefined
  const run = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: fixtureCommand(),
    env: {
      HOME: homedir(),
      USERPROFILE: homedir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      TMPDIR: tmpdir(),
      DSH_HOME: join(homedir(), '.dsh'),
      APPDATA: join(homedir(), 'AppData', 'Roaming'),
    },
    sandbox: {
      mode: 'workspace-write',
      workspaceRoot: layout.root,
      accessMode: 'workspace-write',
      requireFull: false,
    },
  }, {
    host: {
      subprocess: {},
      confine: async (_argv: readonly string[], policy: { workspaceRoot: string }) => {
        root = policy.workspaceRoot
        return { argv: [process.execPath], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }
      },
      spawn: (spec: { env?: NodeJS.ProcessEnv }) => {
        env = spec.env
        throw new Error('spawn-stop')
      },
    } as never,
    onClosed: () => {},
  })
  await assert.rejects(() => run.activate(), /spawn-stop/)
  assert.equal(root, resolve(layout.root))
  assert.notEqual(resolve(root).toLowerCase(), resolve(dirname(layout.root)).toLowerCase())
  assert.equal(env?.HOME, resolve(layout.home))
  assert.equal(env?.USERPROFILE, resolve(layout.home))
  assert.equal(env?.DSH_HOME, resolve(layout.home))
  assert.equal(env?.TMP, resolve(layout.tmp))
  assert.equal(env?.TEMP, resolve(layout.tmp))
  assert.equal(env?.TMPDIR, resolve(layout.tmp))
  assert.equal(env?.APPDATA, join(resolve(layout.home), 'AppData', 'Roaming'))
  assert.notEqual(env?.HOME?.toLowerCase(), resolve(homedir()).toLowerCase())
})

test('spawn maps agentless temp before the child starts and does not spawn a sessionful wrap', async (t) => {
  const layout = await makeBoxLayout('lachesis-map-spawn-')
  t.after(layout.cleanup)
  const prefix = pinnedWindowsAclPrefix()
  const box = resolve(layout.box)
  const agentless = [
    ...prefix, '--workspace', box, '--temp', tmpdir(), '--mode', 'workspace-write', '--', process.execPath, 'agent',
  ]
  let spawned: readonly string[] | undefined
  let spawns = 0
  const host = (argv: readonly string[], spawn: () => void) => ({
    subprocess: {},
    confine: async () => ({ argv, enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }),
    spawn: (spec: { argv: readonly string[] }) => {
      spawns += 1
      spawned = spec.argv
      spawn()
    },
  })
  const run = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: fixtureCommand(),
    sandbox: {
      mode: 'workspace-write',
      workspaceRoot: layout.box,
      tempRoot: layout.tmp,
      accessMode: 'workspace-write',
      requireFull: false,
    },
  }, { host: host(agentless, () => { throw new Error('spawn-stop') }) as never, onClosed: () => {} })
  await assert.rejects(() => run.activate(), /spawn-stop/)
  assert.equal(spawned?.[prefix.length + 3], resolve(layout.tmp))
  assert.notEqual(spawned?.[prefix.length + 3]?.toLowerCase(), resolve(tmpdir()).toLowerCase())
  const dash = agentless.indexOf('--')
  const sessionful = [...agentless.slice(0, dash), '--write-sid', 'S-1', '--temp-write-sid', 'S-2', ...agentless.slice(dash)]
  spawns = 0
  const refused = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: fixtureCommand(),
    sandbox: {
      mode: 'workspace-write',
      workspaceRoot: layout.box,
      tempRoot: layout.tmp,
      accessMode: 'workspace-write',
      requireFull: false,
    },
  }, { host: host(sessionful, () => { throw new Error('spawned') }) as never, onClosed: () => {} })
  await assert.rejects(() => refused.activate(), /Sessionful/)
  assert.equal(spawns, 0)
})

test('a confined child uses the private temp sibling and a sibling write is denied', { timeout: 45_000 }, async (t) => {
  const layout = await makeBoxLayout('lachesis-private-child-')
  t.after(layout.cleanup)
  const escapePath = join(layout.execution, 'sibling-denied.txt')
  t.after(async () => { await rm(escapePath, { force: true }) })
  const executor = createDshAcpExecutor({ bindProcessExit: false })
  t.after(() => executor.closeAll())
  const run = await executor.start({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'provider-a',
    model: 'model-a',
    command: fixtureCommand(),
    sandbox: {
      mode: 'workspace-write',
      workspaceRoot: layout.box,
      tempRoot: layout.tmp,
      accessMode: 'workspace-write',
      requireFull: false,
    },
    env: {
      HOME: homedir(),
      USERPROFILE: homedir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      TMPDIR: tmpdir(),
      DSH_HOME: join(homedir(), '.dsh'),
      APPDATA: join(homedir(), 'AppData', 'Roaming'),
      LACHESIS_FIXTURE_ESCAPE_PATH: escapePath,
    },
  })
  const events = sinkEvents(run)
  await run.send('hello-private')
  const echo = JSON.parse(assistantText(events.items)) as {
    dshHome: string
    home: string
    userProfile: string
    tmp: string
    temp: string
    tmpdir: string
    appData: string
  }
  const privateBase = resolve(layout.tmp)
  assert.equal(echo.dshHome, resolve(layout.home))
  assert.equal(echo.home, resolve(layout.home))
  assert.equal(echo.userProfile, resolve(layout.home))
  assert.equal(echo.appData, join(resolve(layout.home), 'AppData', 'Roaming'))
  assert.equal(echo.tmpdir, privateBase)
  assert.equal(run.processFacts?.sandbox.workspaceRoot, resolve(layout.box))
  if (process.platform === 'win32') {
    assert.equal(echo.temp, echo.tmp)
    assert.equal(resolve(dirname(echo.tmp)).toLowerCase(), privateBase.toLowerCase())
    assert.match(basename(echo.tmp), /^dsh-/)
    assert.notEqual(resolve(dirname(echo.tmp)).toLowerCase(), resolve(tmpdir()).toLowerCase())
  } else {
    assert.equal(echo.tmp, privateBase)
    assert.equal(echo.temp, privateBase)
  }
  const sent = run.send('ESCAPE sibling').then(() => undefined, (error: unknown) => error)
  const violation = await events.waitFor((event) => event.type === 'sandbox_violation', 20_000)
  assert.equal(violation.type, 'sandbox_violation')
  assert.equal(violation.type === 'sandbox_violation' ? violation.verdict.denied : false, true)
  await assert.rejects(stat(escapePath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  await sent
  await run.close().catch(() => undefined)
  const outcome = await run.done
  assert.equal(outcome.rangeExited, true)
  assert.equal(outcome.sandboxViolation?.denied, true)
  assert.notEqual(outcome.exitCode, null)
})
