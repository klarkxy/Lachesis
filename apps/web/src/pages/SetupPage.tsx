import { useState, type FormEvent } from 'react'
import { sessionApi } from '@/api/client'
import { setCsrfToken } from '@/api/session'
import { BrandMark, ErrorBox } from '@/components/ui'
import { describeError } from '@/components/ui'

/**
 * 初次浏览器配对：操作员在运行 Lachesis 服务的本机上取得一次性设置码，
 * 在此完成配对。成功后服务端写入 HttpOnly Cookie，页面保存 CSRF 令牌。
 */
export function SetupPage({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await sessionApi.pair(code.trim())
      setCsrfToken(result.csrfToken)
      onPaired()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  const { message } = error ? describeError(error) : { message: '' }

  return (
    <div className="setup-wrap">
      <div className="setup-panel">
        <div className="setup-brand">
          <BrandMark size={36} />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>Lachesis</div>
            <div className="muted small">工单执行管理 · 初次配对</div>
          </div>
        </div>
        <div className="panel">
          <h1 className="section-title">配对此浏览器</h1>
          <p className="muted small" style={{ marginTop: 0 }}>
            Lachesis 首次在浏览器中打开时需要配对。请在运行服务的本机终端中查看一次性设置码，
            并在此处输入。配对成功后，本会话通过安全 Cookie 与 CSRF 令牌工作。
          </p>
          <form onSubmit={submit}>
            <div className="field">
              <label className="field-label" htmlFor="setup-code">
                一次性设置码
              </label>
              <input
                id="setup-code"
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={busy}
                placeholder="例如 8 位本机设置码"
              />
            </div>
            {error ? <ErrorBox error={error} /> : null}
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
                {busy ? '正在配对…' : '完成配对'}
              </button>
            </div>
          </form>
        </div>
        {message ? null : (
          <p className="muted small" style={{ textAlign: 'center', marginTop: 14 }}>
            设置码不会出现在任何日志或事件中；输入错误不会产生账号或费用。
          </p>
        )}
      </div>
    </div>
  )
}
