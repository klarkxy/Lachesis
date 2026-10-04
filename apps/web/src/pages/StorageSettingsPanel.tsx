import { useEffect, useState, type FormEvent } from 'react'
import { storageApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import type { StoragePolicy } from '@/api/types'
import { useToast } from '@/components/Toast'
import { ErrorBox, Field, LoadingBlock } from '@/components/ui'
import { formatBytes } from '@/lib/time'

export function StorageSettingsPanel() {
  const toast = useToast()
  const status = useQuery(() => storageApi.status(), [])
  const [editing, setEditing] = useState(false)
  const [maxManagedBytes, setMaxManagedBytes] = useState('')
  const [minFreeBytes, setMinFreeBytes] = useState('')
  const [defaultRunReserveBytes, setDefaultRunReserveBytes] = useState('')
  const [artifactPublishReserveBytes, setArtifactPublishReserveBytes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (status.data) {
      const p = status.data.policy
      setMaxManagedBytes(p.maxManagedBytes !== null ? String(p.maxManagedBytes) : '')
      setMinFreeBytes(String(p.minFreeBytes))
      setDefaultRunReserveBytes(String(p.defaultRunReserveBytes))
      setArtifactPublishReserveBytes(String(p.artifactPublishReserveBytes))
    }
  }, [status.data])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const policy: StoragePolicy = {
        maxManagedBytes: maxManagedBytes.trim() ? Number(maxManagedBytes) : null,
        minFreeBytes: Number(minFreeBytes),
        defaultRunReserveBytes: Number(defaultRunReserveBytes),
        artifactPublishReserveBytes: Number(artifactPublishReserveBytes),
        maxCacheBytes: 0,
        executionRetentionHours: 0,
        checkpointRetentionDays: null,
      }
      await storageApi.updatePolicy(policy)
      toast.notify('存储策略已更新')
      setEditing(false)
      status.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (status.loading) {
    return <LoadingBlock label="正在加载存储状态…" />
  }

  if (status.error) {
    return <ErrorBox error={status.error} onRetry={status.refetch} />
  }

  if (!status.data) return null

  const s = status.data

  return (
    <section className="panel" aria-label="存储管理">
      <h2 className="section-title">存储管理</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        排队只保存任务记录，开始执行时才建立工作目录。正在执行的内容、准备好的候选和冻结交付都计入实际占用。
        预算用于调度和预约，不能替代操作系统硬配额。
      </p>

      <p className="muted small">
        每次执行使用私有副本，暂不共享缓存。交付保存且执行进程确认退出后回收已完成执行的工作目录；
        未完成执行和恢复检查点持续保留。
      </p>

      {!editing ? (
        <>
          <dl className="kv">
            <dt>受管存储占用估算</dt>
            <dd>{formatBytes(s.managedBytes)}</dd>
            <dt>卷剩余空间</dt>
            <dd>{formatBytes(s.freeBytes)}</dd>
            <dt>预约占用</dt>
            <dd>{formatBytes(s.reservedBytes)}</dd>
            <dt>活动预约数量</dt>
            <dd>{s.activeReservations}</dd>
            <dt>可派发状态</dt>
            <dd>
              {s.canDispatch ? (
                <span style={{ color: 'var(--st-ok)' }}>可派发</span>
              ) : (
                <span style={{ color: 'var(--st-err)' }}>等待存储条件</span>
              )}
            </dd>
            {s.diagnostic ? (
              <>
                <dt>诊断</dt>
                <dd>{s.diagnostic}</dd>
              </>
            ) : null}
          </dl>

          <hr className="divider" />
          <h3 className="field-label" style={{ marginBottom: 6 }}>
            存储策略
          </h3>
          <dl className="kv">
            <dt>受管存储上限</dt>
            <dd>{s.policy.maxManagedBytes !== null ? formatBytes(s.policy.maxManagedBytes) : '无上限'}</dd>
            <dt>安全余量</dt>
            <dd>{formatBytes(s.policy.minFreeBytes)}</dd>
            <dt>每次执行默认预留</dt>
            <dd>{formatBytes(s.policy.defaultRunReserveBytes)}</dd>
            <dt>发布预留</dt>
            <dd>{formatBytes(s.policy.artifactPublishReserveBytes)}</dd>
          </dl>

          <button type="button" className="btn" onClick={() => setEditing(true)} style={{ marginTop: 10 }}>
            编辑策略
          </button>
        </>
      ) : (
        <form onSubmit={save}>
          <Field label="受管存储上限（字节）" htmlFor="storage-max" hint="留空表示无上限。">
            <input
              id="storage-max"
              className="input mono"
              type="number"
              min="0"
              value={maxManagedBytes}
              onChange={(e) => setMaxManagedBytes(e.target.value)}
              placeholder="无上限"
            />
          </Field>
          <Field label="安全余量（字节）" htmlFor="storage-free" hint="卷剩余空间不得低于此值。">
            <input
              id="storage-free"
              className="input mono"
              type="number"
              min="0"
              value={minFreeBytes}
              onChange={(e) => setMinFreeBytes(e.target.value)}
              required
            />
          </Field>
          <Field label="每次执行默认预留（字节）" htmlFor="storage-run" hint="在源文件复制估算之外，为执行增长预留空间。">
            <input
              id="storage-run"
              className="input mono"
              type="number"
              min="0"
              value={defaultRunReserveBytes}
              onChange={(e) => setDefaultRunReserveBytes(e.target.value)}
              required
            />
          </Field>
          <Field label="发布预留（字节）" htmlFor="storage-publish" hint="每次交付发布的额外预约。">
            <input
              id="storage-publish"
              className="input mono"
              type="number"
              min="0"
              value={artifactPublishReserveBytes}
              onChange={(e) => setArtifactPublishReserveBytes(e.target.value)}
              required
            />
          </Field>
          {error ? <ErrorBox error={error} /> : null}

          <div className="actions-row" style={{ marginTop: 10 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '正在保存…' : '保存策略'}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)} disabled={busy}>
              取消
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
