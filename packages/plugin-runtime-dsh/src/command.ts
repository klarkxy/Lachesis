import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_ACP_PROFILE } from './types.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export function runtimePackageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** Package-local pinned dsh CLI. There is no PATH fallback. */
export function pinnedDshBin(): string {
  return join(runtimePackageRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Default ACP child argv. The pinned package-local runtime is required.
 * `RunSpec.command` remains the explicit custom-command test seam.
 */
export function defaultAcpCommand(): string[] {
  return acpCommandFromPinnedBin(pinnedDshBin(), existsSync(pinnedDshBin()))
}

/** @internal Test seam for the absent-runtime refusal. */
export function acpCommandFromPinnedBin(binPath: string, present: boolean): string[] {
  if (!present) {
    throw new Error('Pinned package-local dsh runtime is absent; refusing a PATH dsh fallback')
  }
  return [process.execPath, binPath, '--profile', DSH_ACP_PROFILE]
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
