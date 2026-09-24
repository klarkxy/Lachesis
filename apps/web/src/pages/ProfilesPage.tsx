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
          <h1 className="page-title">Profile</h1>
          <div className="page-desc">
            可复用的执行配置：供应商、模型与思考强度。同一 Profile 可并行启动多个实例，身份与头像保持一致。
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            新建 Profile
          </button>
        </div>
      </div>

      {query.error ? <ErrorBox error={query.error} onRetry={query.refetch} /> : null}
      {query.loading ? (
        <LoadingBlock label="正在加载 Profile…" />
      ) : profiles.length === 0 ? (
        <EmptyState
          title="还没有 Profile"
          hint="Profile 是执行工单时使用的模型配置。创建一个后即可在工单中指定。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              新建 Profile
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
              <div className="row-aside muted small">{profile.disabled ? '不可用于新工单' : '可用'}</div>
            </Link>
          ))}
        </div>
      )}
      {profiles.length > 0 && enabled.length === 0 ? (
        <div className="notice-box" style={{ marginTop: 12 }}>
          所有 Profile 均已停用，新工单无法指定执行配置。启用或新建一个 Profile 后再派工。
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
