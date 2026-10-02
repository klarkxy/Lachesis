import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_ACP_PROFILE } from './types.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export function runtimePackageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * Default ACP child argv. Prefers the package-local dsh CLI so nothing is
 * installed globally. Callers may override with `RunSpec.command`.
 */
export function defaultAcpCommand(): string[] {
  const dshBin = join(runtimePackageRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(dshBin)) {
    return [process.execPath, dshBin, '--profile', DSH_ACP_PROFILE]
  }
  return ['dsh', '--profile', DSH_ACP_PROFILE]
}

export async function resolveArgv(
  subprocess: SubprocessRuntime,
  command: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const [program, ...rest] = command
  if (program === undefined || program.length === 0) {
    throw new Error('ACP child command must include argv[0]')
  }
  const resolved = isAbsolute(program)
    ? program
    : await subprocess.resolveExecutable(program, compactEnv(env))
  return [resolved, ...rest]
}

function compactEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const compact: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) compact[key] = value
  }
  return compact
}
