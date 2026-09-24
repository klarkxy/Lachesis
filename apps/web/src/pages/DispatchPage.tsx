import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isConflict, profilesApi, projectsApi, schedulerApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import type { DispatchReason, ProjectDispatchState, SchedulerSettings, SchedulerSnapshot } from '@/api/types'
import { useToast } from '@/components/Toast'
import { ErrorBox, Field, LoadingBlock } from '@/components/ui'

type LimitsDraft = Pick<SchedulerSettings, 'globalMaxActive' | 'profileLimits' | 'providerLimits'>

const reasonNames: Record<DispatchReason, string> = {
  ready: '可调度', dependency: '等待依赖应用', paused: '项目已暂停', environment: '环境检查未通过',
  global_capacity: '全局容量已满', profile_capacity: 'Profile 容量已满', provider_capacity: '供应商容量已满',
  profile_unavailable: 'Profile 不可用', scope_busy: '文件范围被占用', running: '执行中',
  needs_input: '等待输入', review: '等待验收', integration: '等待集成', complete: '已完成',
  failed: '执行失败', cancelled: '已取消', recovery: '等待恢复',
}

const diagnosticReasons = new Set<DispatchReason>(['dependency', 'environment', 'profile_unavailable', 'scope_busy', 'failed', 'recovery'])

function useDispatchSnapshot(projectId: string) {
  const [data, setData] = useState<{ filter: string; value: SchedulerSnapshot } | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let disposed = false
    let pending = false
    async function load() {
      if (pending) return
      pending = true
      try {
        const value = await schedulerApi.snapshot(projectId || undefined)
        if (!disposed) {
          setData({ filter: projectId, value })
          setError(null)
        }
      } catch (err) {
        if (!disposed) setError(err)
      } finally {
        pending = false
        if (!disposed) setLoading(false)
      }
    }
    setLoading(dataRef.current?.filter !== projectId)
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [projectId, tick])

  const refetch = useCallback(() => setTick((current) => current + 1), [])
  return { data, loading, error, refetch }
}

function capacityInput(value: number | undefined, onChange: (value: number | undefined) => void, label: string) {
  return <input className="input" style={{ width: 110 }} type="number" min="1" step="1" aria-label={label}
    value={value ?? ''} placeholder="不限" onChange={(event) => {
      const raw = event.target.value
      onChange(raw === '' ? undefined : Number(raw))
    }} />
}

export function DispatchPage() {
  const toast = useToast()
  const [projectId, setProjectId] = useState('')
  const snapshot = useDispatchSnapshot(projectId)
  const currentSnapshot = snapshot.data?.filter === projectId ? snapshot.data.value : null
  const projects = useQuery(() => projectsApi.list(), [])
  const profiles = useQuery(() => profilesApi.list(), [])
  const [draft, setDraft] = useState<LimitsDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [projectBusy, setProjectBusy] = useState<string | null>(null)
  const [readinessMessage, setReadinessMessage] = useState<Record<string, string>>({})

  useEffect(() => {
    if (currentSnapshot && draft === null) {
      const { globalMaxActive, profileLimits, providerLimits } = currentSnapshot.settings
      setDraft({ globalMaxActive, profileLimits: { ...profileLimits }, providerLimits: { ...providerLimits } })
    }
  }, [currentSnapshot, draft])

  function updateLimit(group: 'profileLimits' | 'providerLimits', key: string, value: number | undefined) {
    setDraft((current) => {
      if (!current) return current
      const limits = { ...current[group] }
      if (value === undefined) delete limits[key]
      else limits[key] = value
      return { ...current, [group]: limits }
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !currentSnapshot || saving) return
    setSaving(true)
    setError(null)
    try {
      await schedulerApi.update({ ...draft, expectedVersion: currentSnapshot.settings.version })
      toast.notify('容量设置已保存')
      snapshot.refetch()
    } catch (err) {
      setError(err)
      if (isConflict(err)) snapshot.refetch()
    } finally {
      setSaving(false)
    }
  }

  async function changeProject(state: ProjectDispatchState, action: 'pause' | 'readiness') {
    if (projectBusy) return
    setProjectBusy(state.projectId)
    setError(null)
    try {
      if (action === 'pause') {
        await projectsApi.setPaused(state.projectId, !state.paused, state.version)
        toast.notify(state.paused ? '项目已恢复调度' : '项目已暂停接单')
      } else {
        const result = await projectsApi.checkReadiness(state.projectId, state.version)
        setReadinessMessage((current) => ({ ...current, [state.projectId]: result.readiness.ready
          ? '环境检查通过' : `${result.readiness.code ?? 'environment'}：${result.readiness.diagnostic ?? '检查未通过'}` }))
      }
      snapshot.refetch()
    } catch (err) {
      setError(err)
      if (isConflict(err)) snapshot.refetch()
    } finally {
      setProjectBusy(null)
    }
  }

  const profileRows = profiles.data?.items ?? []
  const knownProfiles = new Set(profileRows.map((profile) => profile.id))
  const extraProfiles = Object.keys(draft?.profileLimits ?? {}).filter((id) => !knownProfiles.has(id))
  const providerRows = [...new Set([...profileRows.map((profile) => profile.providerRef), ...Object.keys(draft?.providerLimits ?? {})])].sort()
  const projectNames = new Map((projects.data?.items ?? []).map((project) => [project.id, project.name]))
  const profileNames = new Map(profileRows.map((profile) => [profile.id, profile.name]))

  return <div className="page">
    <div className="page-head"><div><h1 className="page-title">调度</h1><div className="page-desc">查看容量、项目状态与工单等待原因。</div></div>
      <div className="head-actions"><button type="button" className="btn" onClick={snapshot.refetch}>刷新状态</button></div></div>
    {(!currentSnapshot || snapshot.loading) && !snapshot.error ? <LoadingBlock label="正在加载调度状态…" /> : null}
    {snapshot.error ? <ErrorBox error={snapshot.error} onRetry={snapshot.refetch} /> : null}
    {error ? <ErrorBox error={error} /> : null}
    {currentSnapshot && !snapshot.loading && draft ? <>
      <section className="panel" aria-label="容量设置">
        <h2 className="section-title">容量 <span className="count">{currentSnapshot.activeRunCount} / {currentSnapshot.settings.globalMaxActive}</span></h2>
        <form onSubmit={(event) => void save(event)}>
          <Field label="全局同时执行上限" htmlFor="dispatch-global"><input id="dispatch-global" className="input" style={{ width: 110 }} type="number" min="1" step="1" required
            value={draft.globalMaxActive} onChange={(event) => setDraft((current) => current && { ...current, globalMaxActive: Number(event.target.value) })} /></Field>
          <h3 className="field-label">Profile 上限</h3>
          <div className="dispatch-limits">
            {[...profileRows.map((profile) => ({ id: profile.id, label: profile.name })), ...extraProfiles.map((id) => ({ id, label: id }))].map(({ id, label }) =>
              <label key={id} className="dispatch-limit"><span>{label}<span className="muted small"> · 活跃 {currentSnapshot?.profileActiveCounts[id] ?? 0}</span></span>{capacityInput(draft.profileLimits[id], (value) => updateLimit('profileLimits', id, value), `${label} 同时执行上限`)}</label>)}
          </div>
          <h3 className="field-label" style={{ marginTop: 16 }}>供应商上限</h3>
          <div className="dispatch-limits">{providerRows.map((provider) =>
            <label key={provider} className="dispatch-limit"><span>{provider}<span className="muted small"> · 活跃 {currentSnapshot?.providerActiveCounts[provider] ?? 0}</span></span>{capacityInput(draft.providerLimits[provider], (value) => updateLimit('providerLimits', provider, value), `${provider} 同时执行上限`)}</label>)}</div>
          <p className="muted small">留空表示仅受全局上限约束。</p>
          <button className="btn btn-primary" type="submit" disabled={saving || !Number.isInteger(draft.globalMaxActive) || draft.globalMaxActive < 1 ||
            [...Object.values(draft.profileLimits), ...Object.values(draft.providerLimits)].some((value) => !Number.isInteger(value) || value < 1)}>
            {saving ? '正在保存…' : '保存容量设置'}</button>
        </form>
      </section>
      <section className="panel" aria-label="项目调度">
        <h2 className="section-title">项目</h2>
        {projects.error ? <ErrorBox error={projects.error} onRetry={projects.refetch} /> : null}
        {currentSnapshot.projects.length === 0 ? <p className="muted small">还没有项目。</p> :
          <ul className="list-plain">{currentSnapshot.projects.map((state) => <li key={state.projectId}>
            <div className="dispatch-project"><div><strong>{projectNames.get(state.projectId) ?? state.projectId}</strong>
              <div className="muted small">{state.paused ? '已暂停接单' : '接单中'} · 活跃执行 {state.activeRunCount}{state.paused ? ` · ${state.drainComplete ? '已排空' : '排空中'}` : ''}</div>
              {state.environmentBlock ? <div className="error-box small" style={{ marginTop: 6 }} role="status">{state.environmentBlock.code}：{state.environmentBlock.diagnostic}</div> : null}
              {readinessMessage[state.projectId] ? <div className="muted small" role="status">{readinessMessage[state.projectId]}</div> : null}</div>
              <div className="actions-row"><button type="button" className="btn btn-sm" disabled={projectBusy !== null} onClick={() => void changeProject(state, 'pause')}>{state.paused ? '恢复接单' : '暂停并排空'}</button>
                <button type="button" className="btn btn-sm" disabled={projectBusy !== null} onClick={() => void changeProject(state, 'readiness')}>重查环境</button></div></div>
          </li>)}</ul>}
      </section>
      <section className="panel" aria-label="工单调度原因"><h2 className="section-title">工单等待原因</h2>
        <Field label="筛选项目" htmlFor="dispatch-project-filter"><select id="dispatch-project-filter" className="select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">全部项目</option>{(projects.data?.items ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></Field>
        {currentSnapshot.decisions.length === 0 ? <p className="muted small">当前没有待调度工单。</p> :
          <ul className="list-plain">{currentSnapshot.decisions.map((decision) => <li key={decision.issueId}>
            <div className="dispatch-project"><Link to={`/issues/${encodeURIComponent(decision.issueId)}`}>{decision.issueTitle || `工单 ${decision.issueId.slice(0, 8)}`}</Link><strong>{reasonNames[decision.reason] ?? decision.reason}</strong></div>
            {diagnosticReasons.has(decision.reason) && decision.detail ? <div className="muted small">{decision.detail}</div> : null}
            {decision.profileId ? <div className="muted small">Profile：{profileNames.get(decision.profileId) ?? decision.profileId.slice(0, 8)}</div> : null}
          </li>)}</ul>}
      </section>
    </> : null}
  </div>
}
