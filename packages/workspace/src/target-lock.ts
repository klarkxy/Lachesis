import { realpath } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'
import { Git } from './git.ts'
import { assertAbsolutePath } from './paths.ts'

interface Identity { path: string; metadata: string | null }
interface Holder extends Identity { done: Promise<void> }

function normalized(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function overlaps(left: string, right: string): boolean {
  const rel = relative(left, right)
  return left === right || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
}

/** One coordinator covers aliases, nested targets and shared Git metadata. */
export class TargetLock {
  private readonly holders: Holder[] = []
  private readonly gitBin: string
  constructor(gitBin: string) { this.gitBin = gitBin }

  private async identity(projectRoot: string): Promise<Identity> {
    const path = normalized(await realpath(assertAbsolutePath('projectRoot', projectRoot)))
    const git = new Git(this.gitBin, path)
    const found = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true })
      .catch(() => null)
    const metadata = found?.code === 0 && found.stdout.trim()
      ? normalized(await realpath(resolve(path, found.stdout.trim())).catch(() => resolve(path, found.stdout.trim())))
      : null
    return { path, metadata }
  }

  async targetKey(projectRoot: string): Promise<string> {
    const id = await this.identity(projectRoot)
    return id.metadata ? `git:${id.metadata}` : `files:${id.path}`
  }

  async withTargetLock<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const id = await this.identity(projectRoot)
    for (;;) {
      const conflicting = this.holders.filter((holder) =>
        overlaps(holder.path, id.path) || overlaps(id.path, holder.path) ||
        (id.metadata !== null && id.metadata === holder.metadata))
      if (conflicting.length === 0) break
      await Promise.all(conflicting.map((holder) => holder.done))
    }
    let release!: () => void
    const holder: Holder = { ...id, done: new Promise<void>((resolve) => { release = resolve }) }
    this.holders.push(holder)
    try { return await work() }
    finally {
      this.holders.splice(this.holders.indexOf(holder), 1)
      release()
    }
  }
}
