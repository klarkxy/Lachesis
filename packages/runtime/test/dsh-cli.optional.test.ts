import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { runtimePackageRoot } from '../src/command.ts'
import { SubprocessHost, disposeAcpChild } from '../src/subprocess.ts'

test('pinned dsh 0.1.7-alpha.2 ACP CLI starts without making a model call', async (t) => {
  const dshBin = join(runtimePackageRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.ok(existsSync(dshBin), 'the runtime package must carry the pinned dsh CLI')
  const host = new SubprocessHost()
  const home = mkdtempSync(join(tmpdir(), 'lachesis-dsh-cli-'))
  await host.start()
  try {
    const child = host.spawn({
      argv: [process.execPath, dshBin, '--profile', 'acp', '--help'],
      cwd: process.cwd(),
      env: { DSH_HOME: home },
      graceMs: 3_000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
    })
    const outcome = await child.done
    await disposeAcpChild(child, 1_000)
    t.diagnostic(`isolated dsh --profile acp --help exit=${String(outcome.exitCode)} stdoutChars=${child.collected.stdout?.readFrom(0).text.length ?? 0}`)
    assert.equal(outcome.exitCode, 0)
  } finally {
    await host.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
