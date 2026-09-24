import { mkdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = resolve(process.env.LACHESIS_DATA_DIR || join(root, '.lachesis'))
// The web host profile is launch-private. A second startup must not rewrite
// the active service's profile before the data-root lease rejects it.
const home = await mkdtemp(join(tmpdir(), 'lachesis-service-'))
const profileDir = join(home, 'profiles', 'lachesis')
const staticRoot = join(root, 'apps', 'web', 'dist')
const pluginPath = join(root, 'apps', 'server', 'dist', 'plugin.js')
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const port = Number(process.env.LACHESIS_PORT || '47831')
const launchId = randomUUID()
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('LACHESIS_PORT must be a TCP port from 1 to 65535')
}
await mkdir(profileDir, { recursive: true })

const manifest = {
  name: 'lachesis-runtime-profile',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}
try {
  await readFile(manifestPath)
} catch {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'))
const patch = `- insert:\n` +
  `    - id: lachesis-webserver\n` +
  `      name: '@deepseek-ai/dsh-host-webserver'\n` +
  `      config:\n` +
  `        host: 127.0.0.1\n` +
  `        port: ${port}\n` +
  `    - id: lachesis-service\n` +
  `      name: ${quote(pluginPath)}\n` +
  `      config:\n` +
  `        dataRoot: ${quote(dataRoot)}\n` +
  `        staticRoot: ${quote(staticRoot)}\n` +
  `        launchId: ${quote(launchId)}\n`
await writeFile(patchPath, patch)

process.env.DSH_HOME = home
const values = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
)
const environment = createLaunchEnvironmentSnapshot([
  { source: 'process', values },
])
const tempRoot = resolve(tmpdir())
const target = resolve(home)
if (!target.startsWith(tempRoot + sep)) throw new Error('Service home is outside the OS temp directory')
let shutdown
try {
  ({ shutdown } = await runProfile({
    environment,
    profile: 'lachesis',
    patchFiles: [],
    args: [],
  }))
  // dsh permits optional plugin failures. The service is not ready unless its
  // own route activated; do not leave a webserver answering without Lachesis.
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(3_000),
  })
  const health = response.ok ? (await response.json()).data : null
  if (health?.product !== 'Lachesis' || health?.launchId !== launchId) {
    throw new Error('Lachesis service failed to activate')
  }
  process.once('exit', () => {
    try { rmSync(target, { recursive: true, force: true }) } catch { /* OS temp cleanup is best effort. */ }
  })
} catch (error) {
  if (shutdown) await shutdown.shutdown(1).catch(() => {})
  await rm(target, { recursive: true, force: true })
  throw error
}
