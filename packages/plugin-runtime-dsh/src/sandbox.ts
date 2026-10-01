import { homedir } from 'node:os'
import { parse, relative, resolve, sep } from 'node:path'
import { classifyRunnerFailure, matchesSignature, type ConfinedArgv, type RunnerFailureRule, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { DEFAULT_RUN_SANDBOX_MODE, type RunSandboxFacts, type RunSandboxMode, type RunSandboxVerdict } from './types.ts'

export { DEFAULT_RUN_SANDBOX_MODE }

/**
 * dsh 0.1.7-alpha.2 confines to EXACTLY ONE writable root: `SandboxPolicy` is
 * `{ mode, workspaceRoot, sessionId? }` with no path lists. A Run owns two
 * directories the harness range must be able to write — the workspace
 * (`spec.cwd`) and its isolated dsh home (`spec.dshHome`) — so the granted root
 * is their deepest common ancestor. That ancestor is the service-owned data
 * root in production, never the project target and never a user directory;
 * {@link assertGrantableRoot} refuses to hand a writable grant to anything else.
 */
export function runSandboxRoot(cwd: string, dshHome: string): string {
  const left = resolve(cwd).split(sep).filter(Boolean)
  const right = resolve(dshHome).split(sep).filter(Boolean)
  const shared: string[] = []
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (!sameSegment(left[index]!, right[index]!)) break
    shared.push(left[index]!)
  }
  const root = parse(resolve(cwd)).root
  if (shared.length === 0) return root
  return resolve(root, ...shared)
}

function sameSegment(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Refuse a writable grant that would hand the harness range a filesystem root,
 * the user's home, or anything containing the user's home. Confining with such a
 * root is not confinement: the range could rewrite the operator's own files.
 */
export function assertGrantableRoot(root: string): string {
  const granted = resolve(root)
  const home = resolve(homedir())
  if (granted === parse(granted).root) {
    throw new Error('Refusing to grant a Run writable access to a filesystem root')
  }
  if (granted === home || isInside(home, granted)) {
    throw new Error('Refusing to grant a Run writable access to the user home')
  }
  return granted
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !parse(path).root)
}

/** The confined policy for one Run's harness range. */
export function runSandboxPolicy(mode: RunSandboxMode, workspaceRoot: string): SandboxPolicy {
  // `confine()` carries no session identity: Lachesis is not a dsh-session
  // caller, so the windows-acl rung owns one private temp directory for this
  // single invocation and removes it itself.
  return { mode, workspaceRoot: assertGrantableRoot(workspaceRoot) }
}

/** The reportable facts of one successful wrap. */
export function sandboxFacts(mode: RunSandboxMode, wrap: ConfinedArgv, workspaceRoot: string): RunSandboxFacts {
  return {
    mode,
    workspaceRoot,
    enforcement: wrap.enforcement,
    denialSignatures: [...wrap.denialSignatures],
  }
}

/**
 * Classify a settled harness range against the wrap that confined it, using
 * that backend's own denial dialect and runner-failure rules.
 *
 * Runner failure is checked FIRST and is mutually exclusive with a denial: a
 * runner that refused its profile never executed the harness, so reporting that
 * as "confinement worked" would invert the evidence. Exit status alone is never
 * treated as proof either way.
 */
export function classifySandboxOutcome(
  facts: RunSandboxFacts,
  exitCode: number | null,
  stderr: string,
  runnerFailureRules: readonly RunnerFailureRule[],
): RunSandboxVerdict | undefined {
  if (facts.denialSignatures.length === 0 && runnerFailureRules.length === 0) return undefined
  const runner = classifyRunnerFailure(exitCode, stderr, runnerFailureRules)
  if (runner !== undefined) {
    return verdict(facts, { denied: false, runnerFailed: true, detail: runner.detail })
  }
  if (matchesSignature(exitCode, stderr, facts.denialSignatures)) {
    return verdict(facts, { denied: true, runnerFailed: false, detail: firstMatchingLine(stderr, facts.denialSignatures) })
  }
  return undefined
}

function verdict(
  facts: RunSandboxFacts,
  outcome: { denied: boolean; runnerFailed: boolean; detail: string | null },
): RunSandboxVerdict {
  return { mode: facts.mode, enforcement: facts.enforcement, ...outcome }
}

function firstMatchingLine(stderr: string, signatures: readonly string[]): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const lowered = line.toLowerCase()
    if (signatures.some((signature) => lowered.includes(signature.toLowerCase()))) return line.trim().slice(0, 500)
  }
  return null
}
