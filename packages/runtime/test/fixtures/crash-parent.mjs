import { fileURLToPath } from 'node:url'
import childProcess from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Observe the actual launch seam, since restricted Windows accounts may not read WMI command lines.
const runnerEntry = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')))
const spawn = childProcess.spawn
let runnerPid
childProcess.spawn = function(command, args, options) {
  const child = spawn(command, args, options)
  if (args?.[0] && existsSync(args[0]) && realpathSync(args[0]) === runnerEntry) runnerPid = child.pid
  return child
}
syncBuiltinESMExports()
const { createDshAcpExecutor } = await import('../../src/index.ts')

const executor = createDshAcpExecutor({ bindProcessExit: false })
const handle = await executor.start({
  cwd: process.argv[2],
  dshHome: process.argv[3],
  provider: 'mock-a',
  model: 'model-a',
  command: [process.execPath, fileURLToPath(new URL('./acp-agent.mjs', import.meta.url))],
  env: { LACHESIS_FIXTURE_HANG: 'prompt' },
})
void handle.send('hang until the parent crashes').catch(() => {})
process.send?.({ ready: true, runnerPid, runnerEntry, processFacts: handle.processFacts })
