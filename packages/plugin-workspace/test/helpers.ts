import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Git } from '../src/git.ts'
import { Workspace } from '../src/index.ts'

export async function tempDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    },
  }
}

export async function initGit(dir: string): Promise<Git> {
  await mkdir(dir, { recursive: true })
  const git = new Git('git', dir)
  await git.run(['init', '-b', 'main'])
  await git.run(['config', 'user.email', 'test@lachesis.local'])
  await git.run(['config', 'user.name', 'Lachesis Test'])
  await git.run(['config', 'commit.gpgsign', 'false'])
  await git.run(['config', 'core.autocrlf', 'false'])
  return git
}

export async function commitAll(git: Git, message: string): Promise<string> {
  await git.run(['add', '-A'])
  await git.run(['commit', '--allow-empty', '-m', message])
  return git.text(['rev-parse', 'HEAD'])
}

export async function write(dir: string, rel: string, content: string | Uint8Array): Promise<void> {
  const path = join(dir, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export const stopped = { rangeExited: true as const }

export function verifyNotContaining(file: string, needle: string): string[] {
  return [
    process.execPath,
    '-e',
    `const fs=require('node:fs');const t=fs.readFileSync(${JSON.stringify(file)},'utf8');if(t.includes(${JSON.stringify(needle)}))process.exit(1)`,
  ]
}

export function verifyFileExists(file: string): string[] {
  return [
    process.execPath,
    '-e',
    `require('node:fs').accessSync(${JSON.stringify(file)})`,
  ]
}

export async function makeWorkspace(prefix: string): Promise<{
  root: string
  storeRoot: string
  projectRoot: string
  ws: Workspace
  cleanup: () => Promise<void>
}> {
  const dir = await tempDir(prefix)
  const storeRoot = join(dir.path, 'store')
  const projectRoot = join(dir.path, 'project')
  await mkdir(storeRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  const ws = await Workspace.create({ storeRoot })
  return {
    root: dir.path,
    storeRoot,
    projectRoot,
    ws,
    cleanup: dir.cleanup,
  }
}
