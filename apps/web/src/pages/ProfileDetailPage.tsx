import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isConflict, profilesApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import type { Profile } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { useToast } from '@/components/Toast'
import { EmptyState, ErrorBox, IdTag, LoadingBlock } from '@/components/ui'
import { ProfileFormDialog } from '@/pages/ProfileFormDialog'
import { formatDateTime } from '@/lib/time'

export function ProfileDetailPage() {
  const { profileId = '' } = useParams()
  const toast = useToast()
  // 契约未提供 GET /profiles/:id，单条 Profile 由列表取得（见交付报告 API 缺口）
  const listQuery = useQuery(() => profilesApi.list(), [])
  const historyQuery = useQuery(() => profilesApi.history(profileId), [profileId])

  const [dialog, setDialog] = useState<'edit' | 'copy' | null>(null)
  const [busy, setBusy] = useState(false)

  const profile = listQuery.data?.items.find((p) => p.id === profileId) ?? null

  async function toggleDisabled() {
    if (!profile || busy) return
    setBusy(true)
    try {
      await profilesApi.update(profile.id, { disabled: !profile.disabled }, profile.revision)
      toast.notify(profile.disabled ? 'Profile 已启用' : 'Profile 已停用')
      listQuery.refetch()
    } catch (err) {
      if (isConflict(err)) {
        toast.notifyError('Profile 已被他处修改，已刷新。')
        listQuery.refetch()
      } else {
        toast.notifyError(err instanceof Error ? err.message : '操作失败')
      }
    } finally {
      setBusy(false)
    }
  }

  if (listQuery.loading) {
    return (
      <div className="page">
        <LoadingBlock label="正在加载 Profile…" />
      </div>
    )
  }
  if (listQuery.error) {
    return (
      <div className="page">
        <ErrorBox error={listQuery.error} onRetry={listQuery.refetch} />
      </div>
    )
  }
  if (!profile) {
    return (
      <div className="page">
        <EmptyState
          title="未找到此 Profile"
          hint="它可能已被删除，或当前会话无权查看。"
          action={
            <Link className="btn" to="/profiles">
              返回 Profile 列表
            </Link>
          }
        />
      </div>
    )
  }

  const history = historyQuery.data ?? []

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
          <Avatar presetId={profile.avatarPresetId} size={56} label={profile.name} />
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title">{profile.name}</h1>
            <div className="meta-line">
              <IdTag value={profile.id} />
              <span className="mono">修订 r{profile.revision}</span>
              <span>创建于 {formatDateTime(profile.createdAt)}</span>
              {profile.disabled ? <span className="pill">已停用</span> : null}
            </div>
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => setDialog('edit')}>
            编辑
          </button>
          <button type="button" className="btn" onClick={() => setDialog('copy')}>
            复制
          </button>
          <button type="button" className="btn" onClick={() => void toggleDisabled()} disabled={busy}>
            {profile.disabled ? '启用' : '停用'}
          </button>
        </div>
      </div>

      <div className="cols">
        <div>
          <section className="panel" aria-label="行为配置">
            <h2 className="section-title">行为配置</h2>
            <dl className="kv">
              <dt>供应商引用</dt>
              <dd className="mono">{profile.providerRef}</dd>
              <dt>模型</dt>
              <dd className="mono">{profile.modelId}</dd>
              <dt>思考强度</dt>
              <dd className="mono">{profile.reasoningEffort ?? '供应商默认'}</dd>
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>
              行为配置仅以上三项。修改配置会产生新的修订，此后启动的实例使用新配置；
              同一 Profile 的并行实例始终共享同一头像与当前配置。
            </p>
          </section>

          <section className="panel" aria-label="Profile 履历">
            <h2 className="section-title">
              履历 <span className="count">{history.length} 个修订</span>
            </h2>
            {historyQuery.loading ? (
              <LoadingBlock label="正在加载履历…" />
            ) : historyQuery.error ? (
              <ErrorBox error={historyQuery.error} onRetry={historyQuery.refetch} />
            ) : history.length === 0 ? (
              <p className="muted small">
                还没有评价记录。工单被评价后，这里按配置修订展示平均分与已评工单数；未评分工单不计入。
              </p>
            ) : (
              <>
                <ul className="list-plain">
                  {[...history].reverse().map((entry) => (
                    <li key={entry.revision}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span className="mono">修订 r{entry.revision}</span>
                        {entry.revision === profile.revision ? <span className="pill pill-strong">当前配置</span> : null}
                        <span style={{ marginLeft: 'auto' }}>
                          {entry.evaluatedCount > 0 && entry.averageScore !== null ? (
                            <>
                              <strong>{entry.averageScore.toFixed(1)}</strong>
                              <span className="muted small"> / 5 · {entry.evaluatedCount} 张已评工单</span>
                            </>
                          ) : (
                            <span className="muted small">尚无有效评价</span>
                          )}
                        </span>
                      </div>
                      {entry.issueIds.length > 0 ? (
                        <div className="row-meta" style={{ marginTop: 4 }}>
                          来源工单：
                          {entry.issueIds.map((issueId) => (
                            <Link key={issueId} to={`/issues/${encodeURIComponent(issueId)}`}>
                              <IdTag value={issueId} />
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="muted small" style={{ marginBottom: 0 }}>
                  平均分为已评独立工单的简单均值，每张工单只计最新有效评价；可追溯至具体工单。
                </p>
              </>
            )}
          </section>
        </div>

        <div>
          <section className="panel" aria-label="使用说明">
            <h2 className="section-title">实例与工单</h2>
            <p className="muted small">
              同一 Profile 可并行启动多个实例，实例使用相同头像与配置快照，互不混淆。
              实例入口在对应工单的详情页中；历史执行可通过上方履历中的工单追溯。
            </p>
            <p className="muted small" style={{ marginBottom: 0 }}>
              停用后此 Profile 不能再用于新工单，进行中的执行不受影响。
            </p>
          </section>
        </div>
      </div>

      <ProfileFormDialog
        open={dialog === 'edit'}
        onClose={() => setDialog(null)}
        mode="edit"
        profile={profile}
        onSaved={() => {
          setDialog(null)
          listQuery.refetch()
          historyQuery.refetch()
        }}
      />
      <ProfileFormDialog
        open={dialog === 'copy'}
        onClose={() => setDialog(null)}
        mode="copy"
        profile={profile}
        onSaved={() => {
          setDialog(null)
          toast.notify('已创建副本')
        }}
      />
    </div>
  )
}
