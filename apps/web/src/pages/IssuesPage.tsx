import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { issuesApi, newIdempotencyKey, projectsApi, profilesApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import { getRequesterRef } from '@/api/session'
import type { CreateProjectInput, Issue, Profile, Project, WorkspaceKind } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { Dialog } from '@/components/Dialog'
import { PlanFields, lines } from '@/components/PlanFields'
import { useToast } from '@/components/Toast'
import { Dot, EmptyState, ErrorBox, Field, LoadingBlock, StatusPill } from '@/components/ui'
import { issueStatusMeta } from '@/lib/status'
import { timeAgo } from '@/lib/time'

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'needs_input', label: '等待输入' },
  { value: 'awaiting_review', label: '待验收' },
  { value: 'accepted', label: '已验收' },
  { value: 'failed', label: '失败' },
  { value: 'recovery_required', label: '待恢复' },
  { value: 'cancelled', label: '已取消' },
] as const

export function IssuesPage() {
  const toast = useToast()
  const projectsQuery = useQuery(() => projectsApi.list(), [])
  const profilesQuery = useQuery(() => profilesApi.list(), [])

  const [projectId, setProjectId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  async function load(cursor?: string | null) {
    const append = cursor != null
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setError(null)
    }
    try {
      const page = await issuesApi.list({
        projectId: projectId || undefined,
        status: status || undefined,
        cursor: cursor ?? null,
      })
      setIssues((prev) => (append && prev ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, status])

  // 键盘：/ 聚焦搜索，n 新建工单，↑/↓ 在列表行间移动
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'n') {
        e.preventDefault()
        setCreateOpen(true)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && listRef.current) {
        const links = Array.from(listRef.current.querySelectorAll<HTMLElement>('a.row'))
        if (links.length === 0) return
        const index = links.findIndex((el) => el === document.activeElement)
        e.preventDefault()
        const nextIndex =
          e.key === 'ArrowDown'
            ? index < 0
              ? 0
              : Math.min(index + 1, links.length - 1)
            : index < 0
              ? links.length - 1
              : Math.max(index - 1, 0)
        links[nextIndex]?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const profilesById = useMemo(() => {
    const map = new Map<string, Profile>()
    for (const p of profilesQuery.data?.items ?? []) map.set(p.id, p)
    return map
  }, [profilesQuery.data])

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>()
    for (const p of projectsQuery.data?.items ?? []) map.set(p.id, p)
    return map
  }, [projectsQuery.data])

  const visible = useMemo(() => {
    if (!issues) return null
    const q = search.trim().toLowerCase()
    if (!q) return issues
    return issues.filter((issue) => issue.title.toLowerCase().includes(q) || issue.id.toLowerCase().includes(q))
  }, [issues, search])

  const projects = projectsQuery.data?.items ?? []
  const noProjects = !projectsQuery.loading && projects.length === 0

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">工单</h1>
          <div className="page-desc">按项目查看与创建工单，进入详情执行验收与评价。</div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => setProjectsOpen(true)}>
            管理项目
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={noProjects}
            title={noProjects ? '请先创建项目' : undefined}
          >
            新建工单
          </button>
        </div>
      </div>

      {projectsQuery.error ? <ErrorBox error={projectsQuery.error} onRetry={projectsQuery.refetch} /> : null}

      {noProjects ? (
        <EmptyState
          title="还没有项目"
          hint="工单归属于项目。先创建一个项目，再向其中提交工单。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setProjectsOpen(true)}>
              创建项目
            </button>
          }
        />
      ) : (
        <>
          <div className="toolbar" role="search">
            <select
              className="select"
              style={{ width: 200 }}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label="按项目筛选"
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              ref={searchRef}
              className="input search"
              type="search"
              placeholder="搜索标题或工单号（/）"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="搜索工单"
            />
            <span className="spacer" />
          </div>
          <div className="chips" style={{ marginBottom: 12 }} role="group" aria-label="按状态筛选">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                type="button"
                className="chip"
                aria-pressed={status === s.value}
                onClick={() => setStatus(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
          {loading ? (
            <LoadingBlock label="正在加载工单…" />
          ) : visible && visible.length > 0 ? (
            <>
              <div className="rows" ref={listRef}>
                {visible.map((issue) => {
                  const meta = issueStatusMeta(issue.status)
                  const profile = issue.dispatch.profileId ? profilesById.get(issue.dispatch.profileId) : undefined
                  const project = projectsById.get(issue.projectId)
                  return (
                    <Link key={issue.id} className="row" to={`/issues/${encodeURIComponent(issue.id)}`}>
                      <Dot color={meta.color} />
                      <div className="row-main">
                        <div className="row-title">
                          <span className="t">{issue.title}</span>
                        </div>
                        <div className="row-meta">
                          {project ? <span>{project.name}</span> : null}
                          {profile ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <Avatar presetId={profile.avatarPresetId} size={20} label={profile.name} />
                              {profile.name}
                            </span>
                          ) : (
                            <span>自动分配</span>
                          )}
                          <span className="mono" title={issue.id}>
                            {issue.id.slice(0, 8)}
                          </span>
                          <span>更新于 {timeAgo(issue.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="row-aside">
                        <StatusPill label={meta.label} color={meta.color} />
                      </div>
                    </Link>
                  )
                })}
              </div>
              {nextCursor ? (
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <button type="button" className="btn" onClick={() => void load(nextCursor)} disabled={loadingMore}>
                    {loadingMore ? '正在加载…' : '加载更多'}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              title={search || status ? '没有符合条件的工单' : '还没有工单'}
              hint={
                search || status
                  ? '调整筛选条件或清空搜索后重试。'
                  : '创建第一张工单，指定验收标准与执行 Profile。'
              }
              action={
                search || status ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSearch('')
                      setStatus('')
                    }}
                  >
                    清空筛选
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    新建工单
                  </button>
                )
              }
            />
          )}
        </>
      )}

      <CreateIssueDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects}
        profiles={profilesQuery.data?.items ?? []}
        defaultProjectId={projectId}
        onCreated={(issue) => {
          setCreateOpen(false)
          toast.notify('工单已创建')
          navigate(`/issues/${encodeURIComponent(issue.id)}`)
        }}
      />
      <ProjectsDialog
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        projects={projects}
        onChanged={() => projectsQuery.refetch()}
      />
    </div>
  )
}

// ---------- 新建工单 ----------

function CreateIssueDialog({
  open,
  onClose,
  projects,
  profiles,
  defaultProjectId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  projects: Project[]
  profiles: Profile[]
  defaultProjectId: string
  onCreated: (issue: Issue) => void
}) {
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [mode, setMode] = useState<'require' | 'auto'>('auto')
  const [profileId, setProfileId] = useState('')
  const [dependsOn, setDependsOn] = useState('')
  const [ownedPaths, setOwnedPaths] = useState('')
  const [readOnlyPaths, setReadOnlyPaths] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // 幂等键在表单打开时生成：同一次提交的重试复用同一键，不会生成重复工单
  const [idemKey, setIdemKey] = useState('')

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId || (projects[0]?.id ?? ''))
      setTitle('')
      setDescription('')
      setCriteria('')
      setMode('auto')
      setProfileId('')
      setDependsOn('')
      setOwnedPaths('')
      setReadOnlyPaths('')
      setError(null)
      setIdemKey(newIdempotencyKey())
    }
  }, [open, defaultProjectId, projects])

  const enabledProfiles = profiles.filter((p) => !p.disabled)
  const valid =
    projectId && title.trim() && description.trim() && (mode === 'auto' || profileId)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const issue = await issuesApi.create(
        {
          projectId,
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: criteria
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          dispatch: mode === 'require' ? { mode: 'require', profileId } : { mode: 'auto', profileId: null },
          dependsOn: lines(dependsOn),
          ownedPaths: lines(ownedPaths),
          readOnlyPaths: lines(readOnlyPaths),
          requesterRef: getRequesterRef(),
          clientRequestId: idemKey,
        },
        idemKey,
      )
      onCreated(issue)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="新建工单" busy={busy}>
      <form onSubmit={submit} id="create-issue-form">
        <Field label="所属项目" htmlFor="ci-project">
          <select
            id="ci-project"
            className="select"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标题" htmlFor="ci-title">
          <input
            id="ci-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="一句话说明要完成什么"
          />
        </Field>
        <Field label="任务描述" htmlFor="ci-desc" hint="目标、输入与约束。描述越明确，交付越可验收。">
          <textarea
            id="ci-desc"
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            rows={5}
          />
        </Field>
        <Field label="验收标准" htmlFor="ci-criteria" hint="每行一条；留空表示无显式标准。">
          <textarea
            id="ci-criteria"
            className="textarea"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={3}
            placeholder={'能复现原问题\n回归测试通过'}
          />
        </Field>
        <Field label="执行方式" htmlFor="ci-mode">
          <select
            id="ci-mode"
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'require' | 'auto')}
          >
            <option value="auto">自动分配（由服务策略选择 Profile）</option>
            <option value="require">指定 Profile（必须使用所选配置）</option>
          </select>
        </Field>
        {mode === 'require' ? (
          <Field label="指定 Profile" htmlFor="ci-profile">
            {enabledProfiles.length === 0 ? (
              <div className="notice-box">
                没有可用的 Profile。请先在 Profile 页创建后再指定，或改用自动分配。
              </div>
            ) : (
              <select
                id="ci-profile"
                className="select"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                required
              >
                <option value="" disabled>
                  选择 Profile
                </option>
                {enabledProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.providerRef} / {p.modelId}）
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <PlanFields prefix="ci" dependsOn={dependsOn} ownedPaths={ownedPaths} readOnlyPaths={readOnlyPaths}
          onDependsOn={setDependsOn} onOwnedPaths={setOwnedPaths} onReadOnlyPaths={setReadOnlyPaths} />
        {error ? <ErrorBox error={error} /> : null}
      </form>
      <div className="dialog-foot" style={{ margin: '0 -18px -16px', paddingTop: 12 }}>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="submit" form="create-issue-form" className="btn btn-primary" disabled={!valid || busy}>
          {busy ? '正在创建…' : '创建工单'}
        </button>
      </div>
    </Dialog>
  )
}

// ---------- 项目管理 ----------

function ProjectsDialog({
  open,
  onClose,
  projects,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  projects: Project[]
  onChanged: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<WorkspaceKind>('git')
  const [rootPath, setRootPath] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [verifyCmd, setVerifyCmd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !rootPath.trim() || busy) return
    setBusy(true)
    setError(null)
    const input: CreateProjectInput = {
      name: name.trim(),
      kind,
      rootPath: rootPath.trim(),
    }
    if (kind === 'git' && targetBranch.trim()) input.targetBranch = targetBranch.trim()
    if (verifyCmd.trim()) input.verificationCommand = verifyCmd.trim()
    try {
      await projectsApi.create(input)
      toast.notify('项目已创建')
      setName('')
      setRootPath('')
      setTargetBranch('')
      setVerifyCmd('')
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="项目" busy={busy}>
      {projects.length === 0 ? (
        <p className="muted small">还没有项目。在下方创建第一个项目。</p>
      ) : (
        <ul className="list-plain" aria-label="项目列表">
          {projects.map((p) => (
            <li key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <strong>{p.name}</strong>
                <span className="muted mono">{p.kind === 'git' ? 'Git 工作区' : '文件工作区'}</span>
              </div>
              <div className="muted mono" style={{ overflowWrap: 'anywhere' }}>
                {p.rootPath}
              </div>
            </li>
          ))}
        </ul>
      )}
      <hr className="divider" />
      <h2 className="section-title" style={{ fontSize: 13.5 }}>
        新建项目
      </h2>
      <form onSubmit={submit} id="create-project-form">
        <Field label="名称" htmlFor="cp-name">
          <input id="cp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="工作区类型" htmlFor="cp-kind">
          <select id="cp-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as WorkspaceKind)}>
            <option value="git">Git 工作区</option>
            <option value="files">文件工作区</option>
          </select>
        </Field>
        <Field label="工作区路径" htmlFor="cp-root" hint="服务端本机路径，仅服务端使用，不作为授权凭据。">
          <input
            id="cp-root"
            className="input mono"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            required
            placeholder="例如 C:\\work\\my-repo"
          />
        </Field>
        {kind === 'git' ? (
          <Field label="目标分支（可选）" htmlFor="cp-branch">
            <input id="cp-branch" className="input mono" value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} placeholder="main" />
          </Field>
        ) : null}
        <Field label="验证命令（可选）" htmlFor="cp-verify" hint="集成候选和显式应用时执行，例如测试脚本。">
          <input id="cp-verify" className="input mono" value={verifyCmd} onChange={(e) => setVerifyCmd(e.target.value)} placeholder="npm test" />
        </Field>
        {error ? <ErrorBox error={error} /> : null}
      </form>
      <div className="dialog-foot" style={{ margin: '0 -18px -16px', paddingTop: 12 }}>
        <button type="submit" form="create-project-form" className="btn btn-primary" disabled={busy || !name.trim() || !rootPath.trim()}>
          {busy ? '正在创建…' : '创建项目'}
        </button>
      </div>
    </Dialog>
  )
}
