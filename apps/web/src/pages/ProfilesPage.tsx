import { useState } from 'react'
import { Link } from 'react-router-dom'
import { profilesApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import { Avatar } from '@/components/Avatar'
import { EmptyState, ErrorBox, LoadingBlock } from '@/components/ui'
import { ProfileFormDialog } from '@/pages/ProfileFormDialog'
import { timeAgo } from '@/lib/time'

export function ProfilesPage() {
  const query = useQuery(() => profilesApi.list(), [])
  const [createOpen, setCreateOpen] = useState(false)

  const profiles = query.data?.items ?? []
  const enabled = profiles.filter((p) => !p.disabled)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">执行配置</h1>
          <div className="page-desc">
            谁来做任务：模型、供应商和思考强度。同一份配置可以同时跑多个执行，头像保持不变。
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            新建执行配置
          </button>
        </div>
      </div>

      {query.error ? <ErrorBox error={query.error} onRetry={query.refetch} /> : null}
      {query.loading ? (
        <LoadingBlock label="正在加载执行配置…" />
      ) : profiles.length === 0 ? (
        <EmptyState
          title="还没有执行配置"
          hint="执行配置决定任务用哪个模型。创建一份之后，就可以在任务里指定它。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              新建执行配置
            </button>
          }
        />
      ) : (
        <div className="rows">
          {profiles.map((profile) => (
            <Link key={profile.id} className="row" to={`/profiles/${encodeURIComponent(profile.id)}`}>
              <Avatar presetId={profile.avatarPresetId} size={34} label={profile.name} />
              <div className="row-main">
                <div className="row-title">
                  <span className="t">{profile.name}</span>
                  {profile.disabled ? <span className="pill">已停用</span> : null}
                </div>
                <div className="row-meta">
                  <span className="mono">
                    {profile.providerRef} / {profile.modelId}
                  </span>
                  <span>{profile.reasoningEffort ? `思考强度 ${profile.reasoningEffort}` : '思考强度默认'}</span>
                  <span className="mono muted">修订 r{profile.revision}</span>
                  <span>创建于 {timeAgo(profile.createdAt)}</span>
                </div>
              </div>
              <div className="row-aside muted small">{profile.disabled ? '不能用于新任务' : '可用'}</div>
            </Link>
          ))}
        </div>
      )}
      {profiles.length > 0 && enabled.length === 0 ? (
        <div className="notice-box" style={{ marginTop: 12 }}>
          执行配置都停用了，新任务不能指定它们。启用一份或新建一份后再使用。
        </div>
      ) : null}

      <ProfileFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        mode="create"
        onSaved={() => {
          setCreateOpen(false)
          query.refetch()
        }}
      />
    </div>
  )
}
