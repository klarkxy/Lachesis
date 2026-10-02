import { spawn } from 'node:child_process'
import { WorkspaceError } from './errors.ts'
import type { CommandResult } from './types.ts'

export interface SpawnArgvOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: Uint8Array
  allowFailure?: boolean
  maxOutputBytes?: number
}

class BoundedOutput {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private total = 0
  private readonly limit: number
  constructor(limit: number) { this.limit = limit }
  add(chunk: Buffer): void {
    this.total += chunk.length
    const headLimit = Math.ceil(this.limit / 2)
    const room = headLimit - this.head.length
    if (room > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, room)])
    const rest = chunk.subarray(Math.max(0, room))
    if (rest.length > 0) this.tail = Buffer.concat([this.tail, rest]).subarray(-Math.floor(this.limit / 2))
  }
  get omittedBytes(): number { return Math.max(0, this.total - this.head.length - this.tail.length) }
  text(): string {
    return this.head.toString('utf8') + (this.omittedBytes ? `\n[${this.omittedBytes} bytes omitted]\n` : '') + this.tail.toString('utf8')
  }
}

function assertArgv(file: string, args: readonly string[]): void {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) {
    throw new WorkspaceError('invalid_command', 'Executable path is empty or contains NUL')
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new WorkspaceError('invalid_command', 'Command arguments must be NUL-free strings')
    }
  }
}

function windowsFallbacks(file: string): string[] {
  if (process.platform !== 'win32') return [file]
  if (file.includes('/') || file.includes('\\')) return [file]
  if (/\.(exe|cmd|bat|com)$/i.test(file)) return [file]
  return [file, `${file}.exe`, `${file}.cmd`, `${file}.bat`]
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
}

function executableCommand(file: string, args: readonly string[]): {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
} {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) {
    return { file, args: [...args], windowsVerbatimArguments: false }
  }
  // Node cannot CreateProcess a .cmd file directly. Pass one tightly
  // constrained command line through cmd.exe; metacharacters and expansion
  // syntax are refused even when the caller supplied an argv array.
  if (/[%!^"\r\n]/.test(file) || args.some((arg) => /[&|<>()%!^"\r\n]/.test(arg))) {
    throw new WorkspaceError('invalid_command', 'Unsafe Windows batch command path or argument')
  }
  const command = `""${file}" ${args.map((arg) => `"${arg}"`).join(' ')}"`
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command],
    windowsVerbatimArguments: true,
  }
}

/**
 * Spawn a program with an argv array. Never uses a shell, never concatenates
 * arguments into a command line string.
 */
export async function spawnArgv(
  file: string,
  args: readonly string[],
  options: SpawnArgvOptions,
): Promise<CommandResult> {
  assertArgv(file, args)
  const candidates = windowsFallbacks(file)
  let lastMissing: unknown
  for (const candidate of candidates) {
    try {
      return await spawnOnce(candidate, args, options)
    } catch (error) {
      if (!isMissingExecutable(error)) throw error
      lastMissing = error
    }
  }
  throw new WorkspaceError('invalid_command', `Executable not found: ${file}`, lastMissing)
}

async function spawnOnce(
  file: string,
  args: readonly string[],
  options: SpawnArgvOptions,
): Promise<CommandResult> {
  const executable = executableCommand(file, args)
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable.file, executable.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: executable.windowsVerbatimArguments,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
    const stdout = new BoundedOutput(Math.floor(maxOutputBytes / 2))
    const stderr = new BoundedOutput(Math.ceil(maxOutputBytes / 2))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.add(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.add(chunk)
    })

    if (options.input && child.stdin) {
      child.stdin.end(options.input)
    }

    let timedOut = false
    let stopPromise: Promise<void> | null = null
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          stopPromise = stopProcessTree(child.pid).catch((error: unknown) => {
            reject(new WorkspaceError('recovery_required',
              `Could not confirm timed-out process tree stopped: ${error instanceof Error ? error.message : String(error)}`))
          })
        }, options.timeoutMs)
      : undefined

    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      void (async () => {
        if (stopPromise) await stopPromise
        const omittedBytes = stdout.omittedBytes + stderr.omittedBytes
        resolve({
          code: timedOut ? null : code,
          signal: timedOut ? 'SIGKILL' : signal,
          stdout: stdout.text(), stderr: stderr.text(),
          truncated: omittedBytes > 0, omittedBytes, timedOut,
        })
      })().catch(reject)
    })
  })

  if (!options.allowFailure && result.code !== 0) {
    throw new WorkspaceError(
      'invalid_command',
      `Command ${file} exited ${result.code ?? result.signal ?? 'unknown'}`,
      { file, args, ...result },
    )
  }
  return result
}

async function stopProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) throw new WorkspaceError('recovery_required', 'Timed-out child has no process id')
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    return
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', reject)
      killer.once('close', (code) => code === 0 ? resolve() : reject(
        new WorkspaceError('recovery_required', `Could not confirm process tree ${pid} stopped after timeout`)))
    })
  } catch (error) {
    // Best effort for the direct child. Descendant exit remains unconfirmed,
    // so the caller must keep the candidate in recovery_required.
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone or inaccessible */ }
    throw error
  }
}

const META = /[|&;<>()$`!\n\r]/

/** Split a verification string into argv. Rejects shell metacharacters. */
export function parseArgv(command: string | readonly string[]): string[] {
  if (typeof command !== 'string') {
    if (command.length === 0 || command[0] === undefined || command[0].length === 0) {
      throw new WorkspaceError('invalid_command', 'verificationCommand argv is empty')
    }
    return [...command]
  }
  const text = command.trim()
  if (text.length === 0) {
    throw new WorkspaceError('invalid_command', 'verificationCommand is empty')
  }
  if (META.test(text)) {
    throw new WorkspaceError(
      'invalid_command',
      'verificationCommand must be a single program and arguments; pipes, redirections, and substitutions are not executed',
    )
  }
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) {
    throw new WorkspaceError('invalid_command', 'verificationCommand has an unterminated quote')
  }
  if (current.length > 0) out.push(current)
  if (out.length === 0) {
    throw new WorkspaceError('invalid_command', 'verificationCommand is empty')
  }
  return out
}
