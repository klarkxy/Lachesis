import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthStore } from '../apps/server/dist/auth.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = resolve(process.env.LACHESIS_DATA_DIR || join(root, '.lachesis'))
const auth = new AuthStore(dataRoot)
process.stdout.write(`Lachesis one-time browser pairing code: ${auth.issuePairingCode()}\n`)
