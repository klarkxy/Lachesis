import { spawnArgv, type SpawnArgvOptions } from './spawn.ts'
import { WorkspaceError } from './errors.ts'
import type { CommandResult } from './types.ts'

export function gitIdentityEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GCM_INTERACTIVE: 'never',
    GIT_AUTHOR_NAME: extra?.GIT_AUTHOR_NAME ?? 'Lachesis',
    GIT_AUTHOR_EMAIL: extra?.GIT_AUTHOR_EMAIL ?? 'workspace@lachesis.local',
    GIT_COMMITTER_NAME: extra?.GIT_COMMITTER_NAME ?? 'Lachesis',
    GIT_COMMITTER_EMAIL: extra?.GIT_COMMITTER_EMAIL ?? 'workspace@lachesis.local',
    LC_ALL: 'C',
  }
}

export class Git {
  readonly bin: string
  readonly cwd: string

  constructor(bin: string, cwd: string) {
    this.bin = bin
    this.cwd = cwd
  }

  async run(args: readonly string[], options: Omit<SpawnArgvOptions, 'cwd' | 'env'> & { env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
    const prefixed = ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args]
    try {
      const result = await spawnArgv(this.bin, prefixed, {
        cwd: this.cwd,
        env: gitIdentityEnv(options.env),
        timeoutMs: options.timeoutMs,
        input: options.input,
        allowFailure: options.allowFailure,
      })
      if (result.truncated) throw new WorkspaceError('git_failed', `git ${args[0] ?? ''} output exceeded capture limit`)
      return result
    } catch (error) {
      if (error instanceof WorkspaceError) {
        throw new WorkspaceError('git_failed', error.message, error.details)
      }
      throw new WorkspaceError('git_failed', `git ${args[0] ?? ''} failed`, error)
    }
  }

  async text(args: readonly string[], options?: Omit<SpawnArgvOptions, 'cwd'>): Promise<string> {
    const result = await this.run(args, options)
    return result.stdout.trim()
  }

  async lines(args: readonly string[]): Promise<string[]> {
    const text = await this.text(args)
    if (text.length === 0) return []
    return text.split(/\r?\n/)
  }

  async nulLines(args: readonly string[], input?: Uint8Array, extraEnv?: NodeJS.ProcessEnv): Promise<string[]> {
    const result = await this.run(args, { input, allowFailure: true, env: extraEnv })
    if (result.code !== 0 && result.code !== 1) {
      throw new WorkspaceError('git_failed', `git ${args[0] ?? ''} failed`, result)
    }
    if (result.stdout.length === 0) return []
    return result.stdout.split('\0').filter((line) => line.length > 0)
  }
}

export async function assertGitRepo(git: Git): Promise<void> {
  const result = await git.run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (result.code !== 0 || result.stdout.trim() !== 'true') {
    throw new WorkspaceError('invalid_path', `Not a git work tree: ${git.cwd}`, result)
  }
}

export async function currentBranch(git: Git): Promise<string | null> {
  const result = await git.run(['symbolic-ref', '--short', 'HEAD'], { allowFailure: true })
  if (result.code !== 0) return null
  const name = result.stdout.trim()
  return name.length > 0 ? name : null
}

export async function resolveBranchCommit(git: Git, branch: string | null): Promise<{ branch: string | null; commit: string }> {
  if (branch === null || branch.length === 0) {
    const commit = await git.text(['rev-parse', 'HEAD'])
    return { branch: await currentBranch(git), commit }
  }
  if (branch.includes('\0') || branch.startsWith('-') || branch.includes('..') || /[\s~^:?*\[\\]/.test(branch)) {
    throw new WorkspaceError('invalid_id', `Unsafe git branch name: ${branch}`)
  }
  const result = await git.run(['rev-parse', '--verify', `refs/heads/${branch}`], { allowFailure: true })
  if (result.code !== 0) {
    throw new WorkspaceError('not_found', `Local branch not found: ${branch}`, result)
  }
  return { branch, commit: result.stdout.trim() }
}

export async function worktreeClean(git: Git): Promise<boolean> {
  const result = await git.run(['status', '--porcelain=v1', '-uall'])
  return result.stdout.trim().length === 0
}
