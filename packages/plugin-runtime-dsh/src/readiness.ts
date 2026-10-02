import { randomUUID } from 'node:crypto'
import { lstat, realpath, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { assertAbsoluteDirectory, assertIsolatedDshHome } from './paths.ts'
import { requireNativeWindowsJob } from './subprocess.ts'
import { withDeadline } from './deadline.ts'
import { classifyRuntimeEnvironmentError, diagnosticText, RangeExitUnconfirmedError, RuntimeEnvironmentError } from './errors.ts'
import { DSH_VERSION, type RunSpec, type RuntimeReadiness } from './types.ts'

type ReadinessSpec = Pick<RunSpec, 'cwd' | 'dshHome'>

/** Test seam over real dsh tool backends, not a second implementation of confinement. */
export interface ToolProbeBackend {
  write(path: string, text: string, signal: AbortSignal): Promise<void>
  read(path: string, signal: AbortSignal): Promise<string>
  command(command: string, signal: AbortSignal): Promise<ShellRunResult>
  dispose(): Promise<void>
}

/** Metadata only: never read a provider config or credential to construct a receipt. */
export async function readinessIdentity(spec: ReadinessSpec): Promise<string> {
  const cwd = assertAbsoluteDirectory('cwd', spec.cwd)
  const home = assertIsolatedDshHome(spec.dshHome)
  const parts: unknown[] = [DSH_VERSION, process.execPath, process.platform, process.arch, process.getuid?.()]
  for (const path of [cwd, home]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Readiness requires real, existing private Run directories')
    const physical = await realpath(path)
    const userHome = resolve(homedir())
    if (samePath(physical, parse(physical).root) || samePath(physical, userHome) || samePath(physical, join(userHome, '.dsh'))) {
      throw new Error('Readiness cannot initialize sandbox grants on a user home or filesystem root')
    }
    // Refuse linked ancestors: the caller must pass the actual service-owned path.
    if (!samePath(path, physical)) throw new Error('Readiness requires canonical private Run directories without linked ancestors')
    parts.push(physical, String(info.dev), String(info.ino), info.birthtimeMs)
  }
  if (samePath(cwd, home)) throw new Error('Run workspace and dsh home must be separate directories')
  try {
    const patch = await lstat(join(home, 'cordis.patch.yml'))
    if (!patch.isFile() || patch.isSymbolicLink()) throw new Error('Run configuration must be a regular file')
    parts.push(String(patch.dev), String(patch.ino), patch.size, patch.mtimeMs, patch.ctimeMs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    parts.push(null)
  }
  return JSON.stringify(parts)
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(left) === normalize(right)
}

/**
 * Exercise the pinned ACP profile's enforcing capability implementations directly.
 * No agent/LLM/provider/credential plugins are loaded. The caller supplies a newly
 * prepared private Run workspace; Windows may materialize dsh's normal standing
 * workspace ACL there. It is owned by that Run and disappears with its workspace.
 */
export async function createToolProbeBackend(
  spec: ReadinessSpec,
  timeoutMs: number,
  createContext: () => Context = () => new Context(),
): Promise<ToolProbeBackend> {
  await requireNativeWindowsJob()
  const ctx = createContext()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: spec.cwd })
    await ctx.plugin(LocalSandboxProvider, { probeTimeoutMs: Math.min(timeoutMs, 5_000) })
    await ctx.plugin(SandboxedFileSystem, { cwd: spec.cwd })
    const config = { cwd: spec.cwd, timeoutMs, maxTimeoutMs: timeoutMs, maxOutputBytes: 8_192, maxSpillBytes: 8_192, graceMs: 1_000 }
    if (process.platform === 'win32') await ctx.plugin(SandboxPwshExecutor, config)
    else await ctx.plugin(SandboxBashExecutor, config)
    return {
      write: async (path, text, signal) => {
        const target = await ctx.fs.resolve(path, { signal })
        await ctx.fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, ctx.sandboxPolicy.resolve())
      },
      read: async (path, signal) => ctx.fs.readText(await ctx.fs.resolve(path, { signal }), signal),
      command: async (command, signal) => {
        // Agentless policy still runs the same write-grant + restricted-token path.
        // The runner owns its temporary grant, and reports cleanup errors itself.
        const execution = await ctx.shell.execute(ctx.shell.resolve({
          command, workdir: spec.cwd, timeoutMs, signal, onExpiry: 'kill',
          env: { DSH_HOME: spec.dshHome }, sandboxPolicy: ctx.sandboxPolicy.resolve(),
        }))
        return execution.result()
      },
      dispose: async () => {
        // Context disposal terminates and waits for every subprocess-owned range.
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    try {
      await withDeadline('dsh preflight composition cleanup', 15_000, () => ctx.fiber.dispose())
    } catch (cleanupError) {
      throw new RangeExitUnconfirmedError('dsh preflight composition failed and managed range exit is unconfirmed', {
        cause: new AggregateError([error, cleanupError], 'dsh preflight initialization and cleanup both failed'),
      })
    }
    throw error
  }
}

export async function checkToolReadiness(
  spec: ReadinessSpec,
  timeoutMs = 30_000,
  factory: typeof createToolProbeBackend = createToolProbeBackend,
): Promise<RuntimeReadiness> {
  let backend: ToolProbeBackend | undefined
  let probePath: string | undefined
  let probeOwned = false
  let failure: unknown
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('dsh tool preflight timed out')), timeoutMs)
  try {
    const identity = await readinessIdentity(spec)
    controller.signal.throwIfAborted()
    backend = await factory(spec, timeoutMs)
    controller.signal.throwIfAborted()
    const marker = randomUUID()
    const name = `.lachesis-readiness-${marker}.txt`
    probePath = join(spec.cwd, name)
    await backend.write(probePath, marker, controller.signal)
    probeOwned = true
    if (await backend.read(probePath, controller.signal) !== marker) throw new Error('Filesystem tool probe readback mismatch')
    const result = await backend.command(probeCommand(name, marker), controller.signal)
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.sandbox?.mode !== 'workspace-write'
      || !result.sandbox.enforcement || result.sandbox.denied || result.sandbox.runnerFailed) {
      throw new Error(`dsh confined command probe failed (exit=${String(result.exitCode)}, mode=${String(result.sandbox?.mode)}): ${result.stderr.text}`)
    }
    if (result.stdout.text.trim() !== marker) throw new Error('Confined command did not confirm the expected probe contents')
    if (await backend.read(probePath, controller.signal) !== `${marker}-command`) {
      throw new Error('Confined command write was not visible to the filesystem tool')
    }
    const removed = await backend.command(removeCommand(name, marker), controller.signal)
    if (removed.exitCode !== 0 || removed.timedOut || removed.aborted || removed.sandbox?.mode !== 'workspace-write'
      || !removed.sandbox.enforcement || removed.sandbox.denied || removed.sandbox.runnerFailed || removed.stdout.text.trim() !== marker) {
      throw new Error(`dsh confined probe deletion failed: ${removed.stderr.text}`)
    }
    try {
      await stat(probePath)
      throw new Error('Confined command did not delete the probe')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    controller.signal.throwIfAborted()
    if (identity !== await readinessIdentity(spec)) throw new Error('Run directory or configuration changed during tool preflight')
  } catch (error) {
    // A factory can fail after mounting its process owner, before it publishes
    // a backend. Its cleanup uncertainty has the same recovery semantics.
    if (error instanceof RangeExitUnconfirmedError) throw error
    failure = error
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (backend) {
      try {
        await withDeadline('dsh preflight range cleanup', 15_000, () => backend!.dispose())
      } catch (error) {
        // Do not remove evidence or release startup if descendants might still write.
        throw new RangeExitUnconfirmedError('dsh preflight managed range exit is unconfirmed', { cause: error })
      }
    }
    if (probePath && probeOwned) {
      try {
        // Only our exact random leaf, never recursive removal or a caller's directory.
        if (!samePath(dirname(probePath), spec.cwd)) throw new Error('Invalid readiness cleanup path')
        await unlink(probePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failure = new RuntimeEnvironmentError('preflight_cleanup_failed', diagnosticText(error))
        }
      }
    }
  }
  if (failure) {
    const classified = classifyRuntimeEnvironmentError(failure)
    return { ready: false, code: classified?.code ?? 'tool_preflight_failed', diagnostic: classified?.message ?? diagnosticText(failure) }
  }
  return { ready: true, code: null, diagnostic: null }
}

function probeCommand(name: string, marker: string): string {
  // Both values are generated internally and contain only ASCII hex, hyphens and dots.
  if (process.platform === 'win32') {
    return `$ErrorActionPreference = 'Stop'; $p = Join-Path (Get-Location) '${name}'; if ([IO.File]::ReadAllText($p) -cne '${marker}') { throw 'probe mismatch' }; [IO.File]::WriteAllText($p, '${marker}-command'); Write-Output '${marker}'`
  }
  return `set -eu; test "$(cat '${name}')" = '${marker}'; printf '%s' '${marker}-command' > '${name}'; printf '%s' '${marker}'`
}

function removeCommand(name: string, marker: string): string {
  if (process.platform === 'win32') return `$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath '${name}'; Write-Output '${marker}'`
  return `set -eu; rm -- '${name}'; printf '%s' '${marker}'`
}
