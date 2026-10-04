import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const files = await readdir(process.cwd())
for (const file of files.filter(name => name.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', timeout: 15000 })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (files.includes('tests.mjs')) {
  const result = spawnSync(process.execPath, ['tests.mjs'], { stdio: 'inherit', timeout: 30000 })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Verified syntax of ${files.filter(name => name.endsWith('.mjs')).length} modules${files.includes('tests.mjs') ? ' and real module tests' : ''}`)
