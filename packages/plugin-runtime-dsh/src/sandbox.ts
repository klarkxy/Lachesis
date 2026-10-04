import { existsSync } from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyRunnerFailure, matchesSignature, type ConfinedArgv, type RunnerFailureRule, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { ExecutionPolicyError } from './errors.ts'
import { assertIsolatedDshHome } from './paths.ts'
import {
  DEFAULT_RUN_BOUNDARY_MODE,
  DEFAULT_RUN_SANDBOX_MODE,
  type ExecutionPolicyRequest,
  type ExecutionPolicySupport,
  type RunBoundaryMode,
  type RunSandboxFacts,
  type RunSandboxMode,
  type RunSandboxSpec,
  type RunSandboxVerdict,
} from './types.ts'

export { DEFAULT_RUN_BOUNDARY_MODE, DEFAULT_RUN_SANDBOX_MODE }

/**
 * dsh 0.1.7-alpha.2 confines to EXACTLY ONE writable root: `SandboxPolicy` is
 * `{ mode, workspaceRoot, sessionId? }` with no path lists.
 *
 * Production passes the box explicitly (`execution/<runId>/box`) and a sibling
 * `tempRoot` (`execution/<runId>/tmp`). The grant is the tightest ancestor of
 * cwd and the private home. That temp sibling stays outside the grant. The
 * ancestor fallback remains only when `workspaceRoot` is omitted, for custom
 * fixture commands. The pinned runtime rejects that omission.
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

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(left) === normalize(right)
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertRealDirectory(path: string, kind: 'workspaceRoot' | 'tempRoot' = 'workspaceRoot'): Promise<void> {
  const label = kind === 'workspaceRoot' ? 'Explicit workspaceRoot' : 'tempRoot'
  const noun = kind === 'workspaceRoot' ? 'sandbox root' : 'tempRoot'
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    throw new ExecutionPolicyError(`${label} requires a real directory: ${path}`, { cause: error })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ExecutionPolicyError(`Refusing a linked or non-directory ${noun}`)
  }
  const physical = await realpath(path)
  if (!samePath(path, physical)) {
    throw new ExecutionPolicyError(`Refusing a ${noun} with a linked ancestor`)
  }
}

async function assertInsideRealTree(child: string, root: string): Promise<void> {
  const resolved = resolve(child)
  if (!isInside(resolved, root)) {
    throw new ExecutionPolicyError('Explicit workspaceRoot must contain the Run home and tmp directories')
  }
  let info
  try {
    info = await lstat(resolved)
  } catch (error) {
    throw new ExecutionPolicyError(`Explicit workspaceRoot requires a real Run directory: ${resolved}`, { cause: error })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ExecutionPolicyError('Refusing a linked Run directory inside the sandbox root')
  }
  const physical = await realpath(resolved)
  const physicalRoot = await realpath(root)
  if (!samePath(resolved, physical) || !isInside(physical, physicalRoot)) {
    throw new ExecutionPolicyError('Refusing a linked Run directory outside the sandbox root')
  }
}

async function ensureRealDirectory(path: string, boundary?: string): Promise<void> {
  const target = resolve(path)
  const fence = resolve(boundary ?? dirname(target))
  if (!isInside(target, fence)) {
    throw new ExecutionPolicyError('Refusing to create a private Run directory outside its boundary')
  }
  await assertRealDirectory(fence)
  const physicalFence = await realpath(fence)
  const suffix = relative(fence, target)
  let current = fence
  if (suffix === '') return
  for (const segment of suffix.split(sep)) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new ExecutionPolicyError('Refusing an unsafe private Run directory segment')
    }
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ExecutionPolicyError('Refusing a linked or non-directory private Run path')
    }
    const physical = await realpath(current)
    if (!samePath(current, physical) || !isInside(physical, physicalFence)) {
      throw new ExecutionPolicyError('Refusing a linked private Run directory')
    }
  }
}

/**
 * Fixed facts from installed `@deepseek-ai/dsh-sandbox-local` 0.1.7-alpha.2.
 * `windows-acl` is the sole win32 rung and its static enforcement is partial.
 * Linux probes bwrap then Landlock, so full is not known until wrap.
 * Darwin's sole seatbelt rung is statically full, but read-only still waits
 * for a verified state-only probe.
 */
const PINNED_LOCAL_BACKEND: Partial<Record<string, { runner: string; enforcement: 'full' | 'partial' | 'probed' }>> = {
  win32: { runner: 'windows-acl', enforcement: 'partial' },
  darwin: { runner: 'seatbelt', enforcement: 'full' },
  linux: { runner: 'bwrap', enforcement: 'probed' },
}

/** Queue-time answer for one access mode. Does not spawn, wrap, or write. */
export function nativeExecutionPolicySupport(
  policy: ExecutionPolicyRequest,
  platform: NodeJS.Platform = process.platform,
): ExecutionPolicySupport {
  if (policy.accessMode !== 'read-only' && policy.accessMode !== 'workspace-write') {
    return { supported: false, diagnostic: 'Unknown access mode is unsupported' }
  }
  const backend = PINNED_LOCAL_BACKEND[platform]
  if (policy.accessMode === 'read-only') {
    if (backend?.enforcement === 'partial') {
      return {
        supported: false,
        diagnostic: `Pinned ${backend.runner} enforcement is partial, so read-only execution is unsupported. This adapter will not weaken ACLs.`,
      }
    }
    return {
      supported: false,
      diagnostic: 'Read-only execution is unsupported until state-only readiness is verified.',
    }
  }
  if (policy.requireFull && backend?.enforcement === 'partial') {
    return {
      supported: false,
      diagnostic: `Pinned ${backend.runner} enforcement is partial, so full execution is unsupported. This adapter will not weaken ACLs.`,
    }
  }
  return { supported: true, diagnostic: null }
}

export function assertExecutionPolicySupported(
  spec: { sandbox?: RunSandboxSpec },
  platform: NodeJS.Platform = process.platform,
): void {
  const requested = requestedPolicy(spec.sandbox)
  if (!requested.needsFull) return
  const support = nativeExecutionPolicySupport({
    accessMode: requested.readOnly ? 'read-only' : 'workspace-write',
    requireFull: requested.requireFull,
  }, platform)
  if (!support.supported) {
    throw new ExecutionPolicyError(support.diagnostic ?? 'Execution policy is unsupported')
  }
}

function boundaryModeOf(sandbox: RunSandboxSpec | undefined): RunBoundaryMode {
  const boundary = sandbox?.boundaryMode ?? DEFAULT_RUN_BOUNDARY_MODE
  if (boundary !== 'whole-range' && boundary !== 'native-tools') {
    throw new ExecutionPolicyError('Unknown boundaryMode is unsupported')
  }
  return boundary
}

/**
 * native-tools is only the pinned dsh command, workspace-write, and a trusted
 * host. Read-only, full isolation, and a caller-supplied command are refused
 * before readiness or spawn. whole-range is unchanged.
 */
export function assertNativeToolsBoundary(spec: {
  command?: readonly string[]
  sandbox?: RunSandboxSpec
}): void {
  if (boundaryModeOf(spec.sandbox) !== 'native-tools') return
  if (spec.command !== undefined) {
    throw new ExecutionPolicyError('native-tools refuses a custom command')
  }
  const requested = requestedPolicy(spec.sandbox)
  if (requested.readOnly || requested.requireFull || requested.mode !== 'workspace-write' || requested.accessMode !== 'workspace-write') {
    throw new ExecutionPolicyError('native-tools accepts only workspace-write without full isolation')
  }
}

function requestedPolicy(sandbox: RunSandboxSpec | undefined): {
  mode: RunSandboxMode
  boundaryMode: RunBoundaryMode
  accessMode: 'read-only' | 'workspace-write'
  requireFull: boolean
  readOnly: boolean
  needsFull: boolean
} {
  const mode = sandbox?.mode ?? DEFAULT_RUN_SANDBOX_MODE
  const accessMode = sandbox?.accessMode ?? 'workspace-write'
  const requireFull = sandbox?.requireFull === true
  const readOnly = accessMode === 'read-only' || mode === 'read-only'
  return {
    mode,
    boundaryMode: boundaryModeOf(sandbox),
    accessMode,
    requireFull,
    readOnly,
    needsFull: readOnly || requireFull,
  }
}

export interface ResolvedRunGrant {
  workspaceRoot: string
  mode: RunSandboxMode
  boundaryMode: RunBoundaryMode
  accessMode: 'read-only' | 'workspace-write'
  requireFull: boolean
  /** True when the caller named `sandbox.workspaceRoot`. */
  explicit: boolean
  /** Validated `execution/<runId>/tmp` when the caller named `tempRoot`. */
  tempRoot?: string
}

/** Fixture temp beside the private home when `tempRoot` is omitted. */
export function privateTmpPath(dshHome: string): string {
  return resolve(dirname(resolve(dshHome)), 'tmp')
}

/** The pinned command has no common-ancestor fallback. */
export function assertPinnedWorkspaceRoot(spec: { command?: readonly string[]; sandbox?: RunSandboxSpec }): void {
  if (spec.command === undefined && spec.sandbox?.workspaceRoot === undefined) {
    throw new ExecutionPolicyError('The pinned runtime requires an explicit workspaceRoot')
  }
}

/**
 * `tempRoot` is the direct sibling named `tmp` of the sandbox box.
 * It is canonical, unlinked, and neither a drive root nor the user home.
 */
export async function assertSiblingTemp(workspaceRoot: string, tempRoot: string): Promise<string> {
  let box: string
  let temp: string
  try {
    box = assertGrantableRoot(workspaceRoot)
    temp = assertGrantableRoot(tempRoot)
  } catch (error) {
    throw new ExecutionPolicyError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  if (!samePath(temp, join(dirname(box), 'tmp'))) {
    throw new ExecutionPolicyError('tempRoot must be the tmp sibling of the sandbox root')
  }
  await assertRealDirectory(temp, 'tempRoot')
  return temp
}

/**
 * The single writable root for this Run. An explicit root must be exactly the
 * tightest directory that contains the workspace and the private home. A
 * separate `tempRoot` is not part of that ancestor. A wider root is the service
 * data directory and is refused. Linked roots, drive roots, and the user home
 * are refused too. With no explicit root, the cwd/home ancestor remains for
 * custom fixtures only.
 */
export async function resolveRunGrant(spec: {
  cwd: string
  dshHome: string
  sandbox?: RunSandboxSpec
}): Promise<ResolvedRunGrant> {
  assertNativeToolsBoundary({ sandbox: spec.sandbox })
  const cwd = resolve(spec.cwd)
  const home = resolve(spec.dshHome)
  const legacyTmp = privateTmpPath(home)
  const requested = requestedPolicy(spec.sandbox)
  const explicitRoot = spec.sandbox?.workspaceRoot
  const explicitTemp = spec.sandbox?.tempRoot
  if (explicitTemp !== undefined && explicitRoot === undefined) {
    throw new ExecutionPolicyError('tempRoot requires an explicit workspaceRoot')
  }
  if (explicitRoot === undefined) {
    if (requested.readOnly || requested.requireFull) {
      throw new ExecutionPolicyError('This execution policy requires an explicit workspaceRoot')
    }
    return {
      workspaceRoot: assertGrantableRoot(runSandboxRoot(cwd, home)),
      mode: requested.mode,
      boundaryMode: requested.boundaryMode,
      accessMode: requested.accessMode,
      requireFull: requested.requireFull,
      explicit: false,
    }
  }
  let granted: string
  try {
    granted = assertGrantableRoot(explicitRoot)
  } catch (error) {
    throw new ExecutionPolicyError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  await assertRealDirectory(granted)
  const separateTemp = explicitTemp === undefined ? undefined : await assertSiblingTemp(granted, explicitTemp)
  const required = separateTemp === undefined
    ? (requested.readOnly ? [home, legacyTmp] : [cwd, home, legacyTmp])
    : [cwd, home]
  for (const path of required) {
    if (!isInside(resolve(path), granted)) {
      throw new ExecutionPolicyError('Explicit workspaceRoot must contain the Run workspace and home')
    }
  }
  const tight = required.reduce((current, path) => runSandboxRoot(current, path))
  if (!samePath(granted, tight)) {
    throw new ExecutionPolicyError(
      isInside(tight, granted)
        ? 'Explicit workspaceRoot widens to a service common ancestor'
        : 'Explicit workspaceRoot must contain the Run workspace and home',
    )
  }
  await assertInsideRealTree(home, granted)
  if (separateTemp !== undefined || !requested.readOnly) await assertInsideRealTree(cwd, granted)
  if (separateTemp === undefined && await existsDirectory(legacyTmp)) await assertInsideRealTree(legacyTmp, granted)
  return {
    workspaceRoot: granted,
    mode: requested.mode,
    boundaryMode: requested.boundaryMode,
    accessMode: requested.accessMode,
    requireFull: requested.requireFull,
    explicit: true,
    ...(separateTemp === undefined ? {} : { tempRoot: separateTemp }),
  }
}

/**
 * Confine, then refuse a partial or unknown wrap when the run asked for
 * read-only or full isolation. Unsupported pinned backends fail before the
 * provider is asked, so Windows does not materialize an ACL for those policies.
 */
export async function gateConfinedWrap(
  request: { mode: RunSandboxMode; accessMode: 'read-only' | 'workspace-write'; requireFull: boolean },
  argv: readonly string[],
  policy: SandboxPolicy,
  confine: (argv: readonly string[], policy: SandboxPolicy) => Promise<ConfinedArgv>,
  platform: NodeJS.Platform = process.platform,
): Promise<ConfinedArgv> {
  assertExecutionPolicySupported({ sandbox: request }, platform)
  const wrap = await confine(argv, policy)
  const needsFull = request.accessMode === 'read-only' || request.mode === 'read-only' || request.requireFull
  if (needsFull && wrap.enforcement !== 'full') {
    throw new ExecutionPolicyError(
      wrap.enforcement === 'partial'
        ? 'Partial sandbox enforcement cannot satisfy read-only or full isolation'
        : 'Unknown sandbox enforcement cannot satisfy read-only or full isolation',
    )
  }
  return wrap
}

/** Stable readiness identity and receipt key for one sandbox request. */
export function sandboxCacheFingerprint(sandbox: RunSandboxSpec | undefined): unknown {
  if (sandbox === undefined) return null
  return [
    sandbox.mode ?? null,
    sandbox.workspaceRoot === undefined ? null : resolve(sandbox.workspaceRoot),
    sandbox.tempRoot === undefined ? null : resolve(sandbox.tempRoot),
    sandbox.accessMode ?? null,
    sandbox.requireFull === true,
    sandbox.boundaryMode ?? DEFAULT_RUN_BOUNDARY_MODE,
  ]
}

/** Built argv prefix of the pinned windows-acl runner: `[node, runner.js]`. */
export function pinnedWindowsAclPrefix(): readonly string[] {
  const localMain = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-local'))
  const runner = createRequire(localMain).resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  if (!existsSync(runner)) throw new ExecutionPolicyError('Pinned windows-acl runner is absent')
  return [process.execPath, runner]
}

/**
 * Replace the agentless windows-acl `--temp` base with the private temp root.
 * Sessionful argv already carries SIDs for a temp the SDK created, so rewriting
 * it would detach that grant and its cleanup. Any other prefix is refused.
 */
export function mapAgentlessWindowsTemp(
  argv: readonly string[],
  policy: { mode: string; workspaceRoot: string },
  tempRoot: string,
): string[] {
  const dash = argv.indexOf('--')
  if (dash < 0) throw new ExecutionPolicyError('Refusing to retarget temp on an unrecognized sandbox argv')
  const head = argv.slice(0, dash)
  if (head.includes('--write-sid') || head.includes('--temp-write-sid')) {
    throw new ExecutionPolicyError('Sessionful windows-acl wraps grant temp before argv; refusing to retarget temp')
  }
  const prefix = pinnedWindowsAclPrefix()
  const flags = head.slice(prefix.length)
  const prefixMatches = prefix.every((entry, index) => samePath(head[index] ?? '', entry))
  const shape = flags.length === 6
    && flags[0] === '--workspace'
    && flags[2] === '--temp'
    && flags[4] === '--mode'
    && samePath(flags[1] ?? '', policy.workspaceRoot)
    && flags[5] === policy.mode
  if (!prefixMatches || !shape) {
    throw new ExecutionPolicyError('Refusing to retarget temp on an unrecognized sandbox argv')
  }
  return [...head.slice(0, prefix.length), '--workspace', flags[1]!, '--temp', tempRoot, '--mode', flags[5]!, ...argv.slice(dash)]
}

/** Readiness seam: agentless confines for this backend use the private temp root. */
export function bindAgentlessTempRoot(
  provider: {
    confine: (argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) => Promise<ConfinedArgv>
  },
  tempRoot: string,
): void {
  const confine = provider.confine.bind(provider)
  provider.confine = (argv, policy, signal) => confine(argv, policy, signal).then((wrap) => ({
    ...wrap,
    argv: mapAgentlessWindowsTemp(wrap.argv, policy, tempRoot),
  }))
}

/**
 * Child environment for one Run. `DSH_HOME`, `HOME`, and `USERPROFILE` are the
 * private home. `TMP`, `TEMP`, and `TMPDIR` are the validated `tempRoot` when
 * the caller supplies one, otherwise the fixture temp beside the home. AppData
 * and XDG directories stay under the private home. These names override ambient
 * and caller values.
 *
 * On Windows the agentless runner still rewrites `TMP` and `TEMP` to a
 * `dsh-*` child of its `--temp` parent. That parent is `tempRoot` after
 * {@link mapAgentlessWindowsTemp}. `TMPDIR` stays the private base.
 */
export async function privateRunEnv(spec: {
  dshHome: string
  workspaceRoot?: string
  tempRoot?: string
  boundaryMode?: RunBoundaryMode
}): Promise<Record<string, string>> {
  const home = assertIsolatedDshHome(spec.dshHome)
  await ensureRealDirectory(home)
  if (spec.tempRoot !== undefined && spec.workspaceRoot === undefined) {
    throw new ExecutionPolicyError('tempRoot requires an explicit workspaceRoot')
  }
  const tmp = spec.tempRoot === undefined
    ? privateTmpPath(home)
    : await assertSiblingTemp(spec.workspaceRoot!, spec.tempRoot)
  if (spec.tempRoot === undefined) await ensureRealDirectory(tmp, dirname(home))
  const appData = join(home, 'AppData', 'Roaming')
  const localAppData = join(home, 'AppData', 'Local')
  const xdgConfig = join(home, '.config')
  const xdgCache = join(home, '.cache')
  const xdgData = join(home, '.local', 'share')
  const xdgState = join(home, '.local', 'state')
  for (const path of [appData, localAppData, xdgConfig, xdgCache, xdgData, xdgState]) {
    await ensureRealDirectory(path, home)
  }
  const drive = parse(home).root
  const homePath = relative(drive, home)
  // Spread after the caller env. native-tools pins the profile's workspace-write
  // default; a caller value cannot select danger-full-access.
  return {
    DSH_HOME: home,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: /^[A-Za-z]:\\$/.test(drive) ? drive.slice(0, 2) : drive,
    HOMEPATH: homePath.startsWith(sep) ? homePath : `${sep}${homePath}`,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    ...spec.boundaryMode === 'native-tools' ? { DSH_PERMISSION_MODE: 'workspace-write' } : {},
  }
}

/** The confined policy for one Run's harness range. */
export function runSandboxPolicy(mode: RunSandboxMode, workspaceRoot: string): SandboxPolicy {
  // `confine()` carries no session identity: Lachesis is not a dsh-session
  // caller, so the windows-acl rung owns one private temp directory for this
  // single invocation and removes it itself.
  return { mode, workspaceRoot: assertGrantableRoot(workspaceRoot) }
}

/** The reportable facts of one successful outer wrap. */
export function sandboxFacts(mode: RunSandboxMode, wrap: ConfinedArgv, workspaceRoot: string): RunSandboxFacts {
  return {
    boundaryMode: 'whole-range',
    mode,
    workspaceRoot,
    enforcement: wrap.enforcement,
    denialSignatures: [...wrap.denialSignatures],
  }
}

/** Trusted-host facts. Tool enforcement is the pinned backend, not the harness. */
export function nativeToolsFacts(mode: RunSandboxMode, workspaceRoot: string, platform: NodeJS.Platform = process.platform,
  toolWorkspaceRoot?: string, tempRoot?: string): RunSandboxFacts {
  return {
    boundaryMode: 'native-tools',
    mode,
    workspaceRoot,
    ...(toolWorkspaceRoot === undefined ? {} : { toolWorkspaceRoot }),
    ...(tempRoot === undefined ? {} : { tempRoot }),
    harnessEnforcement: 'trusted-host',
    toolEnforcement: PINNED_LOCAL_BACKEND[platform]?.enforcement ?? 'probed',
    denialSignatures: [],
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
  // native-tools has no outer denial dialect. Tool denials are not harness confinement.
  if (facts.boundaryMode === 'native-tools') return undefined
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
  facts: { mode: RunSandboxMode; enforcement: 'full' | 'partial' },
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
