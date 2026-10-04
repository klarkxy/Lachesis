import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceError } from './errors.ts'
import { sha256Text } from './hash.ts'
import type { FileChange } from './types.ts'
import type { ArtifactStore } from './store.ts'

export interface GitTool {
  bin: string
  blankConfig: string
  hooksPath: string
}

export function projectGitKey(projectRoot: string): string {
  const normalized = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot
  return sha256Text(normalized)
}

export async function ensureGitTool(storeRoot: string, gitBin: string): Promise<GitTool> {
  const root = join(storeRoot, 'git')
  const blankConfig = join(root, 'blank-config')
  const hooksPath = join(root, 'no-hooks')
  await mkdir(hooksPath, { recursive: true })
  if (!existsSync(blankConfig)) await writeFile(blankConfig, '')
  return { bin: gitBin, blankConfig, hooksPath }
}

export function serviceGitPath(storeRoot: string, projectRoot: string): string {
  return join(storeRoot, 'git', projectGitKey(projectRoot), 'repo.git')
}

function sanitizedEnv(tool: GitTool, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT',
  ]) delete env[key]
  env.GIT_CONFIG_GLOBAL = tool.blankConfig
  env.GIT_CONFIG_SYSTEM = tool.blankConfig
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GCM_INTERACTIVE = 'never'
  env.GIT_AUTHOR_NAME = 'Lachesis'
  env.GIT_AUTHOR_EMAIL = 'workspace@lachesis.local'
  env.GIT_COMMITTER_NAME = 'Lachesis'
  env.GIT_COMMITTER_EMAIL = 'workspace@lachesis.local'
  env.LC_ALL = 'C'
  // Caller env wins, including GIT_INDEX_FILE for a service-side index.
  return { ...env, ...extra }
}

function gitPrefix(tool: GitTool, cwd: string): string[] {
  return [
    '-C', cwd,
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
    '-c', 'core.autocrlf=false',
    '-c', 'safe.directory=*',
    '-c', `core.hooksPath=${tool.hooksPath}`,
  ]
}

interface GitOutput {
  code: number | null
  stdout: Buffer
  stderr: string
}

function spawnGit(tool: GitTool, cwd: string, args: readonly string[], input?: Uint8Array, extraEnv?: NodeJS.ProcessEnv): Promise<GitOutput> {
  const candidates = process.platform === 'win32' && !/[\\/]/.test(tool.bin) && !/\.(exe|cmd)$/i.test(tool.bin)
    ? [tool.bin, `${tool.bin}.exe`]
    : [tool.bin]
  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const bin = candidates[index] ?? tool.bin
      const child = spawn(bin, [...gitPrefix(tool, cwd), ...args], {
        cwd,
        env: sanitizedEnv(tool, extraEnv),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => { out.push(chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { err.push(chunk) })
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && index + 1 < candidates.length) {
          attempt(index + 1)
          return
        }
        reject(new WorkspaceError('git_failed', `git ${args[0] ?? ''} failed to start`, error))
      })
      child.once('close', (code) => {
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
      })
      if (input && child.stdin) child.stdin.end(input)
      else child.stdin?.end()
    }
    attempt(0)
  })
}

async function gitText(tool: GitTool, cwd: string, args: readonly string[], options: { input?: Uint8Array; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<GitOutput & { text: string }> {
  const result = await spawnGit(tool, cwd, args, options.input, options.env)
  if (!options.allowFailure && result.code !== 0) {
    throw new WorkspaceError('git_failed', `git ${args[0] ?? ''} failed`, { stderr: result.stderr, stdout: result.stdout.toString('utf8') })
  }
  return { ...result, text: result.stdout.toString('utf8').trim() }
}

export async function ensureBare(tool: GitTool, bare: string): Promise<void> {
  await mkdir(bare, { recursive: true })
  const head = join(bare, 'HEAD')
  if (!existsSync(head)) await gitText(tool, bare, ['init', '--bare'])
  await gitText(tool, bare, ['config', '--local', 'core.bare', 'true'])
  await gitText(tool, bare, ['config', '--local', 'core.hooksPath', tool.hooksPath])
  await assertIsolated(tool, bare)
}

export async function assertIsolated(tool: GitTool, bare: string): Promise<void> {
  const alternates = join(bare, 'objects', 'info', 'alternates')
  if (existsSync(alternates)) {
    throw new WorkspaceError('store_corrupt', 'Service git repository must not borrow objects through alternates')
  }
  const remotes = await gitText(tool, bare, ['remote'], { allowFailure: true })
  if (remotes.code === 0 && remotes.text.length > 0) {
    throw new WorkspaceError('store_corrupt', 'Service git repository must not keep remotes')
  }
  const config = await gitText(tool, bare, ['config', '--local', '--list'], { allowFailure: true })
  if (config.code === 0 && /^(remote\.|credential\.helper=)/im.test(config.text)) {
    throw new WorkspaceError('store_corrupt', 'Service git repository copied operator remotes or credential helpers')
  }
}

export async function hasCommit(tool: GitTool, repo: string, commit: string): Promise<boolean> {
  if (!existsSync(join(repo, 'HEAD')) && !existsSync(join(repo, '.git'))) return false
  const result = await gitText(tool, repo, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true })
  return result.code === 0
}

/** Copy commits and their reachable objects as a pack. Never links or borrows the source. */
export async function copyCommits(tool: GitTool, source: string, dest: string, commits: readonly string[]): Promise<void> {
  const missing: string[] = []
  for (const commit of commits) {
    if (!(await hasCommit(tool, dest, commit))) missing.push(commit)
  }
  if (missing.length === 0) {
    if (existsSync(join(dest, 'HEAD')) && !existsSync(join(dest, '.git'))) await assertIsolated(tool, dest)
    return
  }
  await pipePack(tool, source, dest, missing)
  for (const commit of missing) {
    if (!(await hasCommit(tool, dest, commit))) {
      throw new WorkspaceError('git_failed', `Commit ${commit} was not copied into the destination repository`)
    }
  }
  if (!existsSync(join(dest, '.git'))) await assertIsolated(tool, dest)
}

function pipePack(tool: GitTool, source: string, dest: string, commits: readonly string[]): Promise<void> {
  const candidates = process.platform === 'win32' && !/[\\/]/.test(tool.bin) && !/\.(exe|cmd)$/i.test(tool.bin)
    ? [tool.bin, `${tool.bin}.exe`]
    : [tool.bin]
  return new Promise((resolve, reject) => {
    const start = (index: number): void => {
      const bin = candidates[index] ?? tool.bin
      const pack = spawn(bin, [...gitPrefix(tool, source), 'pack-objects', '--revs', '--stdout'], {
        cwd: source,
        env: sanitizedEnv(tool),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const unpack = spawn(bin, [...gitPrefix(tool, dest), 'unpack-objects'], {
        cwd: dest,
        env: sanitizedEnv(tool),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const errors: string[] = []
      pack.stderr?.on('data', (chunk: Buffer) => { errors.push(chunk.toString('utf8')) })
      unpack.stderr?.on('data', (chunk: Buffer) => { errors.push(chunk.toString('utf8')) })
      pack.stdout?.pipe(unpack.stdin!)
      pack.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && index + 1 < candidates.length) {
          unpack.kill()
          start(index + 1)
          return
        }
        reject(new WorkspaceError('git_failed', 'git pack-objects failed to start', error))
      })
      unpack.once('error', (error) => reject(new WorkspaceError('git_failed', 'git unpack-objects failed to start', error)))
      let packCode: number | null = null
      let unpackCode: number | null = null
      const finish = (): void => {
        if (packCode === null || unpackCode === null) return
        if (packCode !== 0 || unpackCode !== 0) {
          reject(new WorkspaceError('git_failed', `Copying git objects failed (${errors.join('\n').slice(0, 2000)})`))
          return
        }
        resolve()
      }
      pack.once('close', (code) => { packCode = code; finish() })
      unpack.once('close', (code) => { unpackCode = code; finish() })
      pack.stdin?.end(`${commits.join('\n')}\n`)
    }
    start(0)
  })
}

export interface TreeEntry {
  mode: string
  sha: string
  path: string
}

export async function listTree(tool: GitTool, repo: string, commit: string): Promise<TreeEntry[]> {
  const result = await gitText(tool, repo, ['ls-tree', '-r', '-z', commit])
  const entries: TreeEntry[] = []
  const text = result.stdout.toString('utf8')
  for (const line of text.split('\0')) {
    if (line.length === 0) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab)
    const path = line.slice(tab + 1).replace(/\\/g, '/')
    const parts = meta.split(' ')
    const kind = parts[1] ?? ''
    if (kind !== 'blob' || !parts[2]) {
      throw new WorkspaceError('invalid_path', `Unsupported git entry ${path || '(unknown)'} (${kind || 'unknown'})`)
    }
    entries.push({ mode: parts[0] ?? '100644', sha: parts[2], path })
  }
  return entries
}

export async function catBlob(tool: GitTool, repo: string, sha: string): Promise<Buffer> {
  const result = await gitText(tool, repo, ['cat-file', 'blob', sha])
  if (result.stdout.length === 0 && sha.length > 0) {
    // Empty blobs are valid. Confirm the object exists by size header separately only when needed.
  }
  return result.stdout
}

export function gitBlobId(bytes: Uint8Array, objectBytes: number): string {
  const algo = objectBytes === 64 ? 'sha256' : 'sha1'
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

export async function pinRef(tool: GitTool, bare: string, ref: string, commit: string): Promise<void> {
  const zero = '0'.repeat(commit.length)
  await gitText(tool, bare, ['update-ref', ref, commit, zero])
}

export async function refTarget(tool: GitTool, repo: string, ref: string): Promise<string | null> {
  const result = await gitText(tool, repo, ['rev-parse', '--verify', ref], { allowFailure: true })
  if (result.code !== 0) return null
  return result.text
}

export async function reachableBytes(tool: GitTool, repo: string, commit: string): Promise<number | null> {
  const result = await gitText(tool, repo, ['rev-list', '--disk-usage', '--objects', commit], { allowFailure: true })
  if (result.code !== 0) return null
  const value = Number(result.text.split(/\s+/)[0])
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Quote a path for `update-index --index-info` when it would break the TAB/LF record. */
function quoteIndexPath(path: string): string {
  if (!/[\t\n\r"\\]/.test(path)) return path
  const escaped = path.replace(/[\\"\n\r\t]/g, (ch) => {
    if (ch === '\\' || ch === '"') return `\\${ch}`
    if (ch === '\n') return '\\n'
    if (ch === '\r') return '\\r'
    return '\\t'
  })
  return `"${escaped}"`
}

export async function commitDeliveryTree(
  tool: GitTool,
  bare: string,
  parent: string,
  originCommit: string,
  files: readonly FileChange[],
  deliveryId: string,
  indexPath: string,
  store: ArtifactStore,
): Promise<string> {
  await rm(indexPath, { force: true })
  const env = { GIT_INDEX_FILE: indexPath }
  await gitText(tool, bare, ['read-tree', originCommit], { env })
  const hashLength = /^[0-9a-f]{64}$/i.test(parent) || /^[0-9a-f]{64}$/i.test(originCommit) ? 64 : 40
  for (const file of files) {
    if (file.kind === 'deleted') {
      // --remove stats a work tree. The service repo is bare, so drop the path through index-info.
      await gitText(tool, bare, ['update-index', '--index-info'], {
        env,
        input: Buffer.from(`0 ${'0'.repeat(hashLength)} 0\t${quoteIndexPath(file.path)}\n`, 'utf8'),
      })
      continue
    }
    if (!file.sha256) throw new WorkspaceError('store_corrupt', `Delivery file ${file.path} has no blob`)
    const bytes = await store.getBlob(file.sha256)
    const hashed = await gitText(tool, bare, ['hash-object', '-w', '--stdin'], { input: Buffer.from(bytes), env })
    const mode = await fileMode(tool, bare, originCommit, file.path)
    await gitText(tool, bare, ['update-index', '--add', '--cacheinfo', `${mode},${hashed.text},${file.path}`], { env })
  }
  const tree = await gitText(tool, bare, ['write-tree'], { env })
  const commit = await gitText(tool, bare, [
    'commit-tree', tree.text, '-p', parent, '-m', `lachesis-delivery ${deliveryId}`,
  ])
  await rm(indexPath, { force: true }).catch(() => undefined)
  return commit.text
}

async function fileMode(tool: GitTool, bare: string, commit: string, posixPath: string): Promise<string> {
  const result = await gitText(tool, bare, ['ls-tree', commit, '--', posixPath], { allowFailure: true })
  const mode = result.text.split(' ')[0]
  return mode && /^\d{6}$/.test(mode) ? mode : '100644'
}

export async function initWorkRepo(tool: GitTool, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (!existsSync(join(dir, '.git'))) await gitText(tool, dir, ['init', '-b', 'lachesis'])
  await gitText(tool, dir, ['config', '--local', 'core.autocrlf', 'false'])
  await gitText(tool, dir, ['config', '--local', 'core.hooksPath', tool.hooksPath])
  await gitText(tool, dir, ['config', '--local', 'commit.gpgsign', 'false'])
}
