import { mkdir, readFile, rm, symlink, writeFile, mkdtemp } from 'node:fs/promises'
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
const bundleDir = join(root, 'packages', 'base')
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const port = Number(process.env.LACHESIS_PORT || '47831')
const launchId = randomUUID()
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('LACHESIS_PORT must be a TCP port from 1 to 65535')
}
await mkdir(profileDir, { recursive: true })

// The service composition lives in a bundle, not in this script: the profile
// below only names it. dsh resolves a bundle from the installation first, then
// from the profile directory, so a workspace bundle is linked in beside the
// profile rather than copied.
const manifest = {
  name: 'lachesis-runtime-profile',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@lachesis/base'] } },
}
try {
  await readFile(manifestPath)
} catch {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
const bundleScope = join(profileDir, 'node_modules', '@lachesis')
await mkdir(bundleScope, { recursive: true })
try {
  await symlink(bundleDir, join(bundleScope, 'base'), 'junction')
} catch (error) {
  if (error?.code !== 'EEXIST') throw error
}

// This layer is applied after the base bundle and replaces the shipped defaults
// with the values of this run. Each row names the plugin it expects to find, so
// a renamed or moved plugin warns instead of silently taking new configuration.
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'))
const patch = `- insert:\n` +
  `    - id: lachesis-webserver\n` +
  `      name: '@deepseek-ai/dsh-host-webserver'\n` +
  `      config:\n` +
  `        host: 127.0.0.1\n` +
  `        port: ${port}\n` +
  `- id: lachesis-domain\n` +
  `  name: '@lachesis/plugin-domain'\n` +
  `  config:\n` +
  `    dataRoot: ${quote(dataRoot)}\n` +
  `    busyTimeoutMs: 5000\n` +
  `- id: lachesis-workspace\n` +
  `  name: '@lachesis/plugin-workspace'\n` +
  `  config:\n` +
  `    dataRoot: ${quote(dataRoot)}\n` +
  `- id: lachesis-scheduler\n` +
  `  name: '@lachesis/plugin-scheduler'\n` +
  `  config:\n` +
  `    dataRoot: ${quote(dataRoot)}\n` +
  `    tickIntervalMs: 1000\n` +
  `- id: lachesis-server\n` +
  `  name: '@lachesis/server'\n` +
  `  config:\n` +
  `    staticRoot: ${quote(staticRoot)}\n` +
  `    launchId: ${quote(launchId)}\n`
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
  // own routes activated; do not leave a webserver answering without Lachesis.
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(3_000),
  })
  const health = response.ok ? (await response.json()).data : null
  if (health?.product !== 'Lachesis' || health?.launchId !== launchId) {
    throw new Error('Lachesis service failed to activate')
  }
  // The MCP endpoint is a separate fiber that mounts once the HTTP service
  // exists. Until it claims /mcp the SPA fallback answers it with index.html,
  // so an HTML answer here means the composition is not fully up yet.
  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(3_000) })
  if (mcp.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Lachesis MCP endpoint failed to activate')
  }
  process.stdout.write(`Lachesis is ready: http://127.0.0.1:${port}/\nPress Ctrl+C to stop the service.\n`)
  process.once('exit', () => {
    try { rmSync(target, { recursive: true, force: true }) } catch { /* OS temp cleanup is best effort. */ }
  })
} catch (error) {
  if (shutdown) await shutdown.shutdown(1).catch(() => {})
  await rm(target, { recursive: true, force: true })
  throw error
}
