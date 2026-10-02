import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertRelativePosix, assertSafeId, isInside } from '../src/paths.ts'
import { isSensitivePath } from '../src/filter.ts'
import { parseArgv } from '../src/spawn.ts'
import { WorkspaceError } from '../src/errors.ts'
import { resolve } from 'node:path'

test('relative posix paths reject traversal and absolute forms', () => {
  assert.equal(assertRelativePosix('p', 'src/app.js'), 'src/app.js')
  assert.throws(() => assertRelativePosix('p', '../secret'), WorkspaceError)
  assert.throws(() => assertRelativePosix('p', '/etc/passwd'), WorkspaceError)
  assert.throws(() => assertRelativePosix('p', 'foo\\bar'), WorkspaceError)
  assert.throws(() => assertRelativePosix('p', 'a/../../b'), WorkspaceError)
  if (process.platform === 'win32') {
    assert.throws(() => assertRelativePosix('p', 'C:/windows/notepad.exe'), WorkspaceError)
  }
})

test('safe ids reject ref-injection characters', () => {
  assert.equal(assertSafeId('id', 'run-1_ok'), 'run-1_ok')
  assert.throws(() => assertSafeId('id', 'a/b'), WorkspaceError)
  assert.throws(() => assertSafeId('id', 'a..b'), WorkspaceError)
  assert.throws(() => assertSafeId('id', 'refs/heads/main'), WorkspaceError)
})

test('isInside uses resolved prefixes', () => {
  const root = resolve('/tmp/project')
  assert.equal(isInside(root, resolve('/tmp/project/src')), true)
  assert.equal(isInside(root, resolve('/tmp/other')), false)
})

test('sensitive config names are filtered', () => {
  assert.equal(isSensitivePath('.env'), true)
  assert.equal(isSensitivePath('config/.env.local'), true)
  assert.equal(isSensitivePath('secrets.json'), true)
  assert.equal(isSensitivePath('certs/tls.pem'), true)
  assert.equal(isSensitivePath('.dsh/credentials.json'), true)
  assert.equal(isSensitivePath('src/app.js'), false)
})

test('parseArgv refuses shell metacharacters and splits quotes', () => {
  assert.deepEqual(parseArgv('node ./verify.js'), ['node', './verify.js'])
  assert.deepEqual(parseArgv(['node', './verify.js']), ['node', './verify.js'])
  assert.throws(() => parseArgv('node ./verify.js && rm -rf /'), WorkspaceError)
  assert.throws(() => parseArgv('node ./verify.js | cat'), WorkspaceError)
})
