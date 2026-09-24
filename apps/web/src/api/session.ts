/**
 * 浏览器会话状态：配对后服务端设置 HttpOnly Cookie（JS 不可读），
 * CSRF 令牌由配对响应返回，保存在 sessionStorage（随标签页关闭失效）。
 * 会话有效性通过真实请求探测，不假设本地状态等同服务端状态。
 */

const CSRF_KEY = 'lachesis.csrf'
const REQUESTER_KEY = 'lachesis.requesterRef'

export function getCsrfToken(): string | null {
  try {
    return sessionStorage.getItem(CSRF_KEY)
  } catch {
    return null
  }
}

export function setCsrfToken(token: string): void {
  try {
    sessionStorage.setItem(CSRF_KEY, token)
  } catch {
    /* 隐私模式下存储不可用：仅内存态，写入会在刷新后要求重新配对 */
  }
}

export function clearCsrfToken(): void {
  try {
    sessionStorage.removeItem(CSRF_KEY)
  } catch {
    /* ignore */
  }
}

export function getRequesterRef(): string {
  try {
    return localStorage.getItem(REQUESTER_KEY) ?? 'web-operator'
  } catch {
    return 'web-operator'
  }
}

export function setRequesterRef(value: string): void {
  try {
    localStorage.setItem(REQUESTER_KEY, value)
  } catch {
    /* ignore */
  }
}

/** 会话失效时通知应用层（例如 401/403），由 App 切换到配对页。 */
type SessionListener = () => void
const listeners = new Set<SessionListener>()

export function onSessionExpired(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifySessionExpired(): void {
  for (const listener of listeners) listener()
}
