import { useMemo, useState, type FormEvent } from 'react'
import { healthApi, projectsApi, sessionApi, tokensApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import { getCsrfToken, getRequesterRef, setRequesterRef } from '@/api/session'
import type { CreatedToken, McpTokenInfo } from '@/api/types'
import { useToast } from '@/components/Toast'
import { ErrorBox, Field, IdTag, LoadingBlock } from '@/components/ui'
import { formatDateTime } from '@/lib/time'

/** 令牌可授予的权限（与服务端逐条校验的权限名一致，按用途分组）。 */
const TOKEN_PERMISSION_GROUPS: { label: string; permissions: string[] }[] = [
  { label: '调度与项目控制', permissions: ['scheduler.read', 'project.control'] },
  { label: '项目与 Profile', permissions: ['project.read', 'profile.read'] },
  {
    label: '工单',
    permissions: ['issue.create', 'issue.read', 'issue.comment', 'issue.cancel', 'issue.retry', 'issue.accept', 'issue.rework', 'issue.evaluate'],
  },
  { label: '执行', permissions: ['run.read', 'run.message', 'question.answer'] },
  { label: '集成与应用', permissions: ['application.prepare', 'application.read', 'application.apply'] },
  { label: '事件与交付', permissions: ['events.read', 'delivery.read'] },
]

export function SettingsPage() {
  const toast = useToast()
  const health = useQuery(() => healthApi.get(), [])
  const [requester, setRequester] = useState(getRequesterRef())
  const hasCsrf = getCsrfToken() !== null

  function saveRequester(e: FormEvent) {
    e.preventDefault()
    const value = requester.trim()
    if (!value) return
    setRequesterRef(value)
    toast.notify('委托来源标识已保存')
  }

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-desc">浏览器会话、委托来源与服务信息。</div>
        </div>
      </div>

      <section className="panel" aria-label="浏览器会话">
        <h2 className="section-title">浏览器会话</h2>
        <dl className="kv">
          <dt>配对状态</dt>
          <dd>{hasCsrf ? '已配对（Cookie + CSRF 令牌）' : 'Cookie 有效，但此标签页缺少 CSRF 令牌'}</dd>
        </dl>
        {!hasCsrf ? (
          <div className="notice-box" style={{ marginTop: 8 }}>
            读取数据正常，但写操作需要 CSRF 令牌。若写请求被拒绝，请重新配对。
          </div>
        ) : null}
      </section>

      <PairingPanel />

      <TokensPanel />

      <section className="panel" aria-label="委托来源">
        <h2 className="section-title">委托来源</h2>
        <form onSubmit={saveRequester}>
          <Field
            label="来源标识"
            htmlFor="requester-ref"
            hint="创建工单时记录的 requesterRef，用于区分工单来自人类操作员还是外部主 Agent。"
          >
            <input
              id="requester-ref"
              className="input mono"
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
              required
            />
          </Field>
          <button type="submit" className="btn" disabled={!requester.trim()}>
            保存
          </button>
        </form>
      </section>

      <section className="panel" aria-label="服务信息">
        <h2 className="section-title">服务信息</h2>
        {health.loading ? (
          <LoadingBlock label="正在查询服务…" />
        ) : health.error ? (
          <ErrorBox error={health.error} onRetry={health.refetch} />
        ) : (
          <dl className="kv">
            <dt>就绪状态</dt>
            <dd>{health.data?.status ?? '未知'}</dd>
            <dt>运行时版本</dt>
            <dd className="mono">{health.data?.runtimeVersion ?? '服务未上报'}</dd>
          </dl>
        )}
      </section>
    </div>
  )
}

// ---------- 添加另一台浏览器 ----------

function PairingPanel() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [code, setCode] = useState<string | null>(null)

  async function generate() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await sessionApi.issuePairingCode()
      setCode(result.code)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-label="添加另一台浏览器">
      <h2 className="section-title">添加另一台浏览器</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        生成一次性配对码，在另一台浏览器打开本服务的相同地址，于配对页输入该码完成配对。
        配对码只能使用一次；生成新码会使之前未使用的配对码失效。
      </p>
      {error ? <ErrorBox error={error} /> : null}
      {code ? (
        <div className="ok-box" role="status" style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 6 }}>请在另一台浏览器的配对页输入此码：</div>
          <div className="mono" style={{ fontSize: 18, letterSpacing: 2, userSelect: 'all' }}>
            {code}
          </div>
        </div>
      ) : null}
      <button type="button" className="btn" onClick={() => void generate()} disabled={busy}>
        {busy ? '正在生成…' : code ? '重新生成配对码' : '生成配对码'}
      </button>
    </section>
  )
}

// ---------- MCP 访问令牌 ----------

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function TokensPanel() {
  const toast = useToast()
  const tokens = useQuery(() => tokensApi.list(), [])
  const projects = useQuery(() => projectsApi.list(), [])
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set())
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<unknown>(null)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<unknown>(null)

  const projectNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const project of projects.data?.items ?? []) map.set(project.id, project.name)
    return map
  }, [projects.data])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (creating || selectedProjects.size === 0 || selectedPermissions.size === 0) return
    setCreating(true)
    setCreateError(null)
    setCreated(null)
    setCopied(false)
    try {
      const token = await tokensApi.create({
        projectIds: [...selectedProjects],
        permissions: [...selectedPermissions],
      })
      setCreated(token)
      setSelectedProjects(new Set())
      setSelectedPermissions(new Set())
      tokens.refetch()
    } catch (err) {
      setCreateError(err)
    } finally {
      setCreating(false)
    }
  }

  async function copySecret() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
      setCopied(true)
    } catch {
      toast.notifyError('自动复制失败，请手动选中密钥复制。')
    }
  }

  async function revoke(token: McpTokenInfo) {
    if (revokingId) return
    if (!window.confirm(`确认吊销令牌 ${token.id}？使用该令牌的客户端会立即失去访问权限。`)) return
    setRevokingId(token.id)
    setRevokeError(null)
    try {
      await tokensApi.revoke(token.id)
      toast.notify('令牌已吊销')
      tokens.refetch()
    } catch (err) {
      setRevokeError(err)
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <section className="panel" aria-label="MCP 访问令牌">
      <h2 className="section-title">
        访问令牌 <span className="count">{tokens.data?.items.length ?? 0}</span>
      </h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        供外部 HTTP / MCP 客户端使用的 Bearer 令牌，按项目与权限双重限定范围。
        仅本机浏览器会话可以管理令牌；密钥只在创建时显示一次，服务端不保存明文。
      </p>

      {tokens.loading ? (
        <LoadingBlock label="正在加载令牌…" />
      ) : tokens.error ? (
        <ErrorBox error={tokens.error} onRetry={tokens.refetch} />
      ) : tokens.data && tokens.data.items.length > 0 ? (
        <ul className="list-plain" style={{ marginBottom: 12 }}>
          {tokens.data.items.map((token) => (
            <li key={token.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <IdTag value={token.id} />
                <span className="muted small">创建于 {formatDateTime(new Date(token.createdAt).toISOString())}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => void revoke(token)}
                    disabled={revokingId === token.id}
                  >
                    {revokingId === token.id ? '正在吊销…' : '吊销'}
                  </button>
                </span>
              </div>
              <div className="row-meta" style={{ marginTop: 3 }}>
                项目：
                {token.projectIds.map((id) => (
                  <span key={id} className="pill">
                    {projectNames.get(id) ?? id}
                  </span>
                ))}
              </div>
              <div className="row-meta mono" style={{ marginTop: 3 }}>
                {token.permissions.join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">还没有令牌。在下方为外部客户端创建项目范围的访问令牌。</p>
      )}
      {revokeError ? <ErrorBox error={revokeError} /> : null}

      <hr className="divider" />
      <h3 className="field-label" style={{ marginBottom: 6 }}>
        创建令牌
      </h3>
      {created ? (
        <div className="ok-box" role="status" style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 6 }}>令牌已创建。密钥仅此一次显示，请立即复制并妥善保存：</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              readOnly
              className="input mono"
              value={created.token}
              aria-label="新令牌密钥"
              onFocus={(e) => e.target.select()}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button type="button" className="btn btn-sm" onClick={() => void copySecret()}>
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreated(null)}>
              我已保存
            </button>
          </div>
        </div>
      ) : null}
      <form onSubmit={create}>
        <Field label="项目范围" hint="令牌只能访问选中的项目。">
          {projects.data && projects.data.items.length === 0 ? (
            <p className="muted small">还没有项目；请先在工单页创建项目。</p>
          ) : (
            <div className="chips" role="group" aria-label="选择项目范围">
              {(projects.data?.items ?? []).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="chip"
                  aria-pressed={selectedProjects.has(project.id)}
                  onClick={() => setSelectedProjects((prev) => toggleIn(prev, project.id))}
                >
                  {project.name}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="权限范围" hint="仅授予客户端实际需要的最小权限。">
          <div style={{ display: 'grid', gap: 6 }}>
            {TOKEN_PERMISSION_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="muted small" style={{ marginBottom: 3 }}>
                  {group.label}
                </div>
                <div className="chips" role="group" aria-label={`权限：${group.label}`}>
                  {group.permissions.map((permission) => (
                    <button
                      key={permission}
                      type="button"
                      className="chip mono"
                      aria-pressed={selectedPermissions.has(permission)}
                      onClick={() => setSelectedPermissions((prev) => toggleIn(prev, permission))}
                    >
                      {permission}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Field>
        {createError ? <ErrorBox error={createError} /> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || selectedProjects.size === 0 || selectedPermissions.size === 0}
          >
            {creating ? '正在创建…' : '创建令牌'}
          </button>
        </div>
      </form>
    </section>
  )
}
