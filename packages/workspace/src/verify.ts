import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VerificationReport } from '@lachesis/contracts'
import type { Evidence } from './types.ts'
import { parseArgv, spawnArgv } from './spawn.ts'
import { gitIdentityEnv } from './git.ts'
import { WorkspaceError } from './errors.ts'

const MAX_OUTPUT_BYTES = 1024 * 1024 - 4096

function redact(text: string): string {
  let clean = text
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /(?:KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH)/i.test(name)) {
      clean = clean.split(value).join('[REDACTED]')
    }
  }
  return clean
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(["']?[A-Za-z0-9_]*?(?:KEY|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_]*?["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      '$1[REDACTED]')
    .replace(/\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
}

function summarize(output: string, failed: boolean, exitCode: number | null, signal: string | null): string {
  const lines = output.split(/\r?\n/)
  const important: string[] = []
  if (failed) {
    for (let i = 0; i < lines.length; i += 1) {
      if (/\b(?:not ok|error|failed?|assert(?:ion)?|expected|actual|stack)\b|\bat\s+.*:\d+/i.test(lines[i]!)) {
        important.push(...lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)))
      }
    }
  }
  const selected = [...new Set(important)].join('\n').slice(-4_000)
  const tail = output.slice(-4_000)
  return [`exit ${exitCode ?? signal ?? 'unknown'}`, selected, tail].filter(Boolean).join('\n').slice(-8_000)
}

/** Save one bounded report at the phase location before returning evidence. */
export async function runVerification(
  cwd: string,
  command: string | readonly string[] | null,
  timeoutMs = 120_000,
  artifactPath?: string,
): Promise<Evidence> {
  if (command === null || (typeof command === 'string' && command.trim().length === 0)) {
    return { kind: 'verification', label: 'project verification', outcome: 'unknown',
      detail: 'No verificationCommand configured' }
  }
  const startedAt = new Date().toISOString()
  let argv: string[] = []
  let code: number | null = null
  let signal: string | null = null
  let output = ''
  let omittedBytes = 0
  let truncated = false
  let timedOut = false
  try {
    argv = parseArgv(command)
    const [file, ...args] = argv
    const result = await spawnArgv(file!, args, {
      cwd, env: gitIdentityEnv(), timeoutMs, allowFailure: true,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    code = result.code
    signal = result.signal
    omittedBytes = result.omittedBytes ?? 0
    truncated = result.truncated ?? false
    timedOut = result.timedOut ?? false
    output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'recovery_required') throw error
    output = error instanceof Error ? error.message : String(error)
  }
  output = redact(output)
  const summary = `${timedOut ? `Timed out after ${timeoutMs} ms\n` : ''}${summarize(output, code !== 0, code, signal)}`
  const report: VerificationReport = {
    command: argv.map(redact), exitCode: code, signal,
    startedAt, finishedAt: new Date().toISOString(),
    truncated, omittedBytes, output, summary,
  }
  if (artifactPath) {
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  return { kind: 'verification', label: 'project verification',
    outcome: code === 0 ? 'passed' : 'failed', detail: summary }
}
