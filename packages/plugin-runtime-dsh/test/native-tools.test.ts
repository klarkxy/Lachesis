import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import { ExecutionPolicyError, RangeExitUnconfirmedError, SubprocessHost } from '../src/index.ts'
import { DshAcpRuntime } from '../src/executor.ts'
import { defaultAcpCommand } from '../src/command.ts'
import { AcpRun } from '../src/run.ts'
import { checkToolReadiness, readinessIdentity } from '../src/readiness.ts'
import { sandboxCacheFingerprint } from '../src/sandbox.ts'
import { fixtureCommand } from './helpers.ts'

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
  return {
    execution,
    box,
    cwd,
    home,
    tmp,
    cleanup: async () => {
      await rm(execution, { recursive: true, force: true })
    },
  }
}

function nativeSandbox(layout: { box: string; tmp: string }, extra: Record<string, unknown> = {}) {
  return {
    mode: 'workspace-write' as const,
    workspaceRoot: layout.box,
    tempRoot: layout.tmp,
    accessMode: 'workspace-write' as const,
    requireFull: false,
    boundaryMode: 'native-tools' as const,
    ...extra,
  }
}

test('native-tools refuses read-only, full, and a custom command before readiness or spawn', async (t) => {
  const layout = await makeBoxLayout('lachesis-native-refuse-')
  t.after(layout.cleanup)
  const runtime = new DshAcpRuntime({ bindProcessExit: false })
  t.after(() => runtime.closeAll())
  const refused = [
    nativeSandbox(layout, { accessMode: 'read-only', requireFull: false }),
    nativeSandbox(layout, { accessMode: 'workspace-write', requireFull: true }),
    nativeSandbox(layout, { mode: 'read-only', accessMode: 'workspace-write', requireFull: false }),
  ]
  for (const sandbox of refused) {
    let invoked = false
    await assert.rejects(() => checkToolReadiness({
      cwd: layout.cwd,
      dshHome: layout.home,
      sandbox,
    }, 1_000, async () => {
      invoked = true
      throw new Error('factory')
    }), ExecutionPolicyError)
    assert.equal(invoked, false)
    await assert.rejects(async () => {
      await runtime.checkReadiness({ cwd: layout.cwd, dshHome: layout.home, sandbox })
    }, ExecutionPolicyError)
    let spawns = 0
    const run = new AcpRun({
      cwd: layout.cwd,
      dshHome: layout.home,
      provider: 'p',
      model: 'm',
      sandbox,
    }, {
      host: {
        subprocess: {},
        confine: async () => { throw new Error('confine') },
        spawn: () => { spawns += 1; throw new Error('spawned') },
      } as never,
      onClosed: () => {},
    })
    await assert.rejects(() => run.activate(), ExecutionPolicyError)
    assert.equal(spawns, 0)
  }

  let customSpawns = 0
  const custom = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: defaultAcpCommand(),
    sandbox: nativeSandbox(layout),
  }, {
    host: {
      subprocess: {},
      confine: async () => { throw new Error('confine') },
      spawn: () => { customSpawns += 1; throw new Error('spawned') },
    } as never,
    onClosed: () => {},
  })
  await assert.rejects(() => custom.activate(), /custom command/)
  assert.equal(customSpawns, 0)
  await assert.rejects(async () => {
    await runtime.start({
      cwd: layout.cwd,
      dshHome: layout.home,
      provider: 'p',
      model: 'm',
      command: fixtureCommand(),
      sandbox: nativeSandbox(layout),
    })
  }, /custom command/)
})

test('whole-range still confines, and a confine failure does not spawn or switch boundary', async (t) => {
  const layout = await makeBoxLayout('lachesis-native-keep-whole-')
  t.after(layout.cleanup)
  let confined = 0
  let spawns = 0
  const whole = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: fixtureCommand(),
    sandbox: {
      mode: 'workspace-write',
      workspaceRoot: layout.box,
      accessMode: 'workspace-write',
      requireFull: false,
      boundaryMode: 'whole-range',
    },
  }, {
    host: {
      subprocess: {},
      confine: async (_argv: readonly string[], policy: { workspaceRoot: string }) => {
        confined += 1
        assert.equal(policy.workspaceRoot, resolve(layout.box))
        return {
          argv: ['wrapped', ..._argv],
          enforcement: 'partial' as const,
          denialSignatures: [],
          runnerFailureRules: [],
        }
      },
      spawn: (spec: { argv: readonly string[]; env?: NodeJS.ProcessEnv }) => {
        spawns += 1
        assert.equal(spec.argv[0], 'wrapped')
        assert.equal(spec.env?.DSH_PERMISSION_MODE, undefined)
        throw new Error('whole-spawn-stop')
      },
    } as never,
    onClosed: () => {},
  })
  await assert.rejects(() => whole.activate(), /whole-spawn-stop/)
  assert.equal(confined, 1)
  assert.equal(spawns, 1)

  confined = 0
  spawns = 0
  const failed = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    command: fixtureCommand(),
    sandbox: {
      workspaceRoot: layout.box,
      tempRoot: layout.tmp,
      accessMode: 'workspace-write',
      requireFull: false,
    },
  }, {
    host: {
      subprocess: {},
      confine: async () => { confined += 1; throw new Error('confine-failed') },
      spawn: () => { spawns += 1; throw new Error('spawned') },
    } as never,
    onClosed: () => {},
  })
  await assert.rejects(() => failed.activate(), /confine-failed/)
  assert.equal(confined, 1)
  assert.equal(spawns, 0)
})

test('native-tools cache identity follows boundaryMode and keeps the config digest', async (t) => {
  const layout = await makeBoxLayout('lachesis-native-cache-')
  t.after(layout.cleanup)
  const whole = {
    workspaceRoot: layout.box,
    tempRoot: layout.tmp,
    accessMode: 'workspace-write' as const,
    requireFull: false,
  }
  const native = { ...whole, boundaryMode: 'native-tools' as const }
  assert.deepEqual(
    sandboxCacheFingerprint(whole),
    sandboxCacheFingerprint({ ...whole, boundaryMode: 'whole-range' }),
  )
  assert.notDeepEqual(sandboxCacheFingerprint(whole), sandboxCacheFingerprint(native))
  const spec = { cwd: layout.cwd, dshHome: layout.home }
  assert.notEqual(
    await readinessIdentity({ ...spec, sandbox: whole }),
    await readinessIdentity({ ...spec, sandbox: native }),
  )
  const path = join(layout.home, 'cordis.patch.yml')
  await writeFile(path, 'key: synthetic-a')
  const before = await readinessIdentity({ ...spec, sandbox: native })
  assert.match(before, /[a-f0-9]{64}/)
  assert.equal(await readinessIdentity({ ...spec, sandbox: native }), before)
})

test('native-tools readiness uses the session cwd as the tool root and pins permission mode', async (t) => {
  const layout = await makeBoxLayout('lachesis-native-ready-')
  t.after(layout.cleanup)
  const prototype = process.platform === 'win32' ? SandboxPwshExecutor.prototype : SandboxBashExecutor.prototype
  let seen: {
    env?: Record<string, string>
    sandboxPolicy?: { mode?: string; workspaceRoot?: string }
  } | undefined
  t.mock.method(prototype, 'execute', async (request: {
    command: string
    env?: Record<string, string>
    sandboxPolicy?: { mode?: string; workspaceRoot?: string }
  }) => {
    seen ??= request
    const name = request.command.match(/\.lachesis-readiness-([a-f0-9-]+)\.txt/)
    assert.ok(name)
    const path = join(layout.cwd, name[0])
    const marker = name[1]
    if (/Remove-Item|rm --/.test(request.command)) await unlink(path)
    else await writeFile(path, `${marker}-command`)
    return {
      result: async () => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false,
        stdout: { text: marker, truncated: false }, stderr: { text: '', truncated: false },
        sandbox: { mode: 'workspace-write', enforcement: 'partial', denied: false, runnerFailed: false },
      }),
    }
  })
  const result = await checkToolReadiness({
    cwd: layout.cwd,
    dshHome: layout.home,
    sandbox: nativeSandbox(layout),
  }, 20_000)
  assert.equal(result.ready, true, result.diagnostic ?? 'native-tools readiness failed')
  assert.equal(seen?.sandboxPolicy?.mode, 'workspace-write')
  assert.equal(seen?.sandboxPolicy?.workspaceRoot, resolve(layout.cwd))
  assert.notEqual(seen?.sandboxPolicy?.workspaceRoot?.toLowerCase(), resolve(layout.box).toLowerCase())
  assert.equal(seen?.env?.DSH_PERMISSION_MODE, 'workspace-write')
  assert.equal(seen?.env?.HOME, resolve(layout.home))
  assert.equal(seen?.env?.TMP, resolve(layout.tmp))
  assert.equal(seen?.env?.TEMP, resolve(layout.tmp))
  assert.equal(seen?.env?.TMPDIR, resolve(layout.tmp))
})

test('native-tools spawns the pinned command unwrapped under the native Job', { timeout: 25_000 }, async (t) => {
  const layout = await makeBoxLayout('lachesis-native-job-')
  t.after(layout.cleanup)
  const parentFile = join(layout.cwd, 'job-parent.pid')
  const childFile = join(layout.cwd, 'job-child.pid')
  const real = new SubprocessHost()
  await real.start()
  t.after(() => real.dispose())
  let confineCalls = 0
  let spawned: { argv: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string } | undefined
  const sleeper = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.LACHESIS_JOB_PARENT, String(process.pid));",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "fs.writeFileSync(process.env.LACHESIS_JOB_CHILD, String(child.pid || 0));",
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const run = new AcpRun({
    cwd: layout.cwd,
    dshHome: layout.home,
    provider: 'p',
    model: 'm',
    env: {
      DSH_PERMISSION_MODE: 'danger-full-access',
      HOME: homedir(),
      USERPROFILE: homedir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      TMPDIR: tmpdir(),
      DSH_HOME: join(homedir(), '.dsh'),
    },
    sandbox: nativeSandbox(layout),
  }, {
    host: {
      subprocess: real.subprocess,
      confine: async () => {
        confineCalls += 1
        throw new Error('outer confine')
      },
      spawn: (spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; graceMs: number; stdio: unknown }) => {
        spawned = spec
        return real.spawn({
          ...spec,
          argv: [process.execPath, '-e', sleeper],
          env: {
            ...spec.env,
            LACHESIS_JOB_PARENT: parentFile,
            LACHESIS_JOB_CHILD: childFile,
          },
        })
      },
    } as never,
    startupTimeoutMs: 1_000,
    eofGraceMs: 200,
    disposeTimeoutMs: 8_000,
    onClosed: () => {},
  })
  const activation = run.activate().then(() => {
    throw new Error('native-tools sleeper unexpectedly became ready')
  }, (error: unknown) => error)
  const sleeperPid = await readPid(parentFile)
  const facts = run.processFacts?.sandbox
  assert.equal(facts?.boundaryMode, 'native-tools')
  if (facts?.boundaryMode === 'native-tools') {
    assert.equal(facts.harnessEnforcement, 'trusted-host')
    assert.equal(facts.toolEnforcement, process.platform === 'win32' ? 'partial' : facts.toolEnforcement)
    assert.equal('enforcement' in facts, false)
  }
  assert.equal(confineCalls, 0)
  assert.ok(spawned)
  assert.deepEqual([...spawned.argv], defaultAcpCommand())
  assert.equal(spawned.argv.some((entry) => entry.includes('windows-acl')), false)
  assert.equal(spawned.cwd, resolve(layout.cwd))
  assert.equal(spawned.env?.DSH_PERMISSION_MODE, 'workspace-write')
  assert.notEqual(spawned.env?.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(spawned.env?.HOME, resolve(layout.home))
  assert.equal(spawned.env?.DSH_HOME, resolve(layout.home))
  assert.equal(spawned.env?.TMP, resolve(layout.tmp))
  assert.equal(spawned.env?.TEMP, resolve(layout.tmp))
  assert.equal(spawned.env?.TMPDIR, resolve(layout.tmp))
  if (process.platform === 'win32') {
    const parent = parentProcess(sleeperPid)
    assert.notEqual(parent.pid, process.pid)
    assert.match(parent.command, /dsh-subprocess-local/)
    assert.match(parent.command, /runner/)
  }
  const failure = await activation
  assert.ok(!(failure instanceof RangeExitUnconfirmedError), failure instanceof Error ? failure.message : String(failure))
  const outcome = await run.done
  assert.equal(outcome.rangeExited, true)
  const childPid = Number(await readFile(childFile, 'utf8'))
  assert.equal(await dies(sleeperPid), true)
  assert.equal(await dies(childPid), true)
})

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(path, 'utf8')).trim())
      if (Number.isInteger(value) && value > 0) return value
    } catch {
      // The Job child publishes the pid after spawn.
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`pid file was not published: ${path}`)
}

function parentProcess(pid: number): { pid: number; command: string } {
  const command = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`,
    'if ($null -eq $p) { exit 2 };',
    '$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)";',
    'Write-Output $p.ParentProcessId;',
    'Write-Output $parent.CommandLine;',
  ].join(' ')
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  })
  const [parentLine = '', ...rest] = stdout.split(/\r?\n/)
  return { pid: Number(parentLine.trim()), command: rest.join('\n') }
}

async function dies(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !alive(pid)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
