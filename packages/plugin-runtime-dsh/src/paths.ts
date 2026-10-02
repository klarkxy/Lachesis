import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

const DEFAULT_HOME = resolve(homedir(), '.dsh')

export function assertAbsoluteDirectory(label: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path`)
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`)
  }
  return resolve(value)
}

/** Refuse the operator's default harness home so Runs cannot share user credentials. */
export function assertIsolatedDshHome(dshHome: string): string {
  const resolved = assertAbsoluteDirectory('dshHome', dshHome)
  if (resolved === DEFAULT_HOME) {
    throw new Error('dshHome must not be the user ~/.dsh; each Run needs an isolated home')
  }
  return resolved
}
