import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AuthError, AuthStore } from '../src/auth.js'

function request(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}

test('pairing is one use and tokens remain scoped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lachesis-auth-'))
  try {
    const auth = new AuthStore(dir)
    const code = auth.initialSetupCode
    assert.ok(code)
    const pair = auth.pair(code)
    assert.throws(() => auth.pair(code), (error) => error instanceof AuthError && error.code === 'invalid_setup_code')
    const cookie = pair.cookie.split(';')[0]!
    const browser = request('POST', { cookie, origin: 'http://127.0.0.1:47831', host: '127.0.0.1:47831', 'x-csrf-token': pair.csrf })
    assert.equal(auth.authenticate(browser, 'issue.accept').kind, 'browser')
    assert.throws(() => auth.authenticate(request('POST', { cookie, origin: 'http://evil.test', host: '127.0.0.1:47831', 'x-csrf-token': pair.csrf }), 'issue.accept'),
      (error) => error instanceof AuthError && error.code === 'invalid_origin')
    assert.throws(() => auth.authenticate(request('POST', { cookie, origin: 'http://127.0.0.1:47831', host: '127.0.0.1:47831' }), 'issue.accept'),
      (error) => error instanceof AuthError && error.code === 'invalid_csrf')

    const issued = auth.createToken(['project-a'], ['issue.read'])
    const external = request('GET', { authorization: `Bearer ${issued.token}` })
    assert.equal(auth.authenticate(external, 'issue.read', 'project-a').id, issued.id)
    assert.throws(() => auth.authenticate(external, 'issue.read', 'project-b'),
      (error) => error instanceof AuthError && error.code === 'project_denied')
    assert.throws(() => auth.authenticate(external, 'issue.accept', 'project-a'),
      (error) => error instanceof AuthError && error.code === 'permission_denied')
    assert.equal(auth.revokeToken(issued.id), true)
    assert.throws(() => auth.authenticate(external, 'issue.read', 'project-a'),
      (error) => error instanceof AuthError && error.code === 'invalid_token')

    const persisted = readFileSync(join(dir, 'auth.json'), 'utf8')
    assert.equal(persisted.includes(code), false)
    assert.equal(persisted.includes(issued.token), false)
    assert.equal(persisted.includes(cookie), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
