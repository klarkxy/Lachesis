import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

export interface Actor {
  kind: 'browser' | 'token'
  id: string
  projectIds: string[] | null
  permissions: string[] | null
}

interface Session {
  hash: string
  csrf: string
  expiresAt: number
}

interface Token {
  hash: string
  id: string
  projectIds: string[]
  permissions: string[]
  createdAt: number
}

interface AuthData {
  version: 1
  setupHash: string | null
  sessions: Session[]
  tokens: Token[]
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export class AuthError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
  }
}

export class AuthStore {
  private readonly path: string
  private readonly data: AuthData
  readonly initialSetupCode: string | null

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true })
    this.path = join(dataRoot, 'auth.json')
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as AuthData
      if (parsed.version !== 1) throw new Error('Unsupported Lachesis auth data version')
      this.data = parsed
      this.initialSetupCode = null
    } else {
      const code = randomBytes(8).toString('hex')
      this.data = { version: 1, setupHash: sha(code), sessions: [], tokens: [] }
      this.initialSetupCode = code
      this.save()
    }
  }

  private save(): void {
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  pair(code: string): { cookie: string; csrf: string } {
    if (this.data.setupHash === null || !equal(this.data.setupHash, sha(code))) {
      throw new AuthError('invalid_setup_code', 401, 'The setup code is invalid or has been used')
    }
    const secret = randomBytes(32).toString('base64url')
    const csrf = randomBytes(24).toString('base64url')
    this.data.sessions.push({ hash: sha(secret), csrf, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 })
    this.data.setupHash = null
    this.save()
    return { cookie: `lachesis_session=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, csrf }
  }

  issuePairingCode(): string {
    const code = randomBytes(8).toString('hex')
    this.data.setupHash = sha(code)
    this.save()
    return code
  }

  session(req: IncomingMessage): { actor: Actor; csrf: string } | null {
    const cookie = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('lachesis_session='))
    if (!cookie) return null
    const secret = cookie.slice('lachesis_session='.length)
    const hash = sha(secret)
    const record = this.data.sessions.find((session) => equal(session.hash, hash) && session.expiresAt > Date.now())
    if (!record) return null
    return { actor: { kind: 'browser', id: 'local-operator', projectIds: null, permissions: null }, csrf: record.csrf }
  }

  authenticate(req: IncomingMessage, permission: string, projectId?: string): Actor {
    const browser = this.session(req)
    if (browser) {
      if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
        const expectedOrigin = `http://${req.headers.host}`
        if (req.headers.origin !== expectedOrigin) {
          throw new AuthError('invalid_origin', 403, 'Browser origin does not match this service')
        }
        if (req.headers['x-csrf-token'] !== browser.csrf) {
          throw new AuthError('invalid_csrf', 403, 'The browser session needs a fresh CSRF token')
        }
      }
      return browser.actor
    }
    const actor = this.authenticateToken(req)
    if (actor.permissions === null || (!actor.permissions.includes(permission) && !actor.permissions.includes('*'))) {
      throw new AuthError('permission_denied', 403, 'This token cannot perform the requested action')
    }
    if (projectId && actor.projectIds !== null && !actor.projectIds.includes(projectId)) {
      throw new AuthError('project_denied', 403, 'This token cannot access the project')
    }
    return actor
  }

  authenticateToken(req: IncomingMessage): Actor {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new AuthError('authentication_required', 401, 'Sign in to Lachesis')
    const hash = sha(header.slice(7))
    const token = this.data.tokens.find((item) => equal(item.hash, hash))
    if (!token) throw new AuthError('invalid_token', 401, 'The access token is invalid')
    return { kind: 'token', id: token.id, projectIds: token.projectIds, permissions: token.permissions }
  }

  createToken(projectIds: string[], permissions: string[]): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url')
    const id = randomBytes(8).toString('hex')
    this.data.tokens.push({ hash: sha(token), id, projectIds, permissions, createdAt: Date.now() })
    this.save()
    return { token, id }
  }

  revokeToken(id: string): boolean {
    const before = this.data.tokens.length
    this.data.tokens = this.data.tokens.filter((token) => token.id !== id)
    if (this.data.tokens.length !== before) this.save()
    return this.data.tokens.length !== before
  }

  listTokens(): Array<{ id: string; projectIds: string[]; permissions: string[]; createdAt: number }> {
    return this.data.tokens.map(({ id, projectIds, permissions, createdAt }) => ({ id, projectIds, permissions, createdAt }))
  }
}
