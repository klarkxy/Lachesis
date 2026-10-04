import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Plus, Search } from 'lucide-react'
import { issuesApi, newIdempotencyKey, profilesApi, projectsApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import { getRequesterRef } from '@/api/session'
import type { CreateProjectInput, Issue, IssueListItem, Profile, Project, WorkspaceKind } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { Dialog } from '@/components/Dialog'
import { PlanFields, lines } from '@/components/PlanFields'
import { useProjectCatalog } from '@/components/ProjectCatalog'
import { useToast } from '@/components/Toast'
import { Dot, EmptyState, ErrorBox, Field, LoadingBlock, StatusPill } from '@/components/ui'
import { BOARD_COLUMNS, columnForStatus } from '@/lib/board'
import { issueBoardMeta } from '@/lib/status'
import { timeAgo } from '@/lib/time'
import { useProjectTasks } from '@/lib/useProjectTasks'

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'queued', label: '排队等待' },
  { value: 'blocked', label: '等待依赖' },
  { value: 'starting', label: '正在启动' },
  { value: 'running', label: '执行中' },
  { value: 'needs_input', label: '需要回答' },
  { value: 'awaiting_review', label: '待验收' },
  { value: 'accepted', label: '已验收' },
  { value: 'failed', label: '执行失败' },
  { value: 'recovery_required', label: '需要恢复' },
  { value: 'cancelled', label: '已取消' },
] as const

export function IssuesPage() {
  const [params] = useSearchParams()
  const project = params.get('project') ?? ''
  const status = params.get('view') === 'list' ? (params.get('status') ?? '') : ''
  return <IssuesWorkspace key={JSON.stringify([project, status])} />
}

function IssuesWorkspace() {
  const toast = useToast()
  const catalog = useProjectCatalog()
  const profilesQuery = useQuery(() => profilesApi.list(), [])
  const [params, setParams] = useSearchParams()
  const projectId = params.get('project') ?? ''
  const view = params.get('view') === 'list' ? 'list' : 'board'
  const search = params.get('q') ?? ''
  const status = view === 'list' ? (params.get('status') ?? '') : ''

  const [issues, setIssues] = useState<IssueListItem[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)
  const navigate = useNavigate()

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  async function load(cursor?: string | null) {
    const append = cursor != null
    const token = append ? requestId.current : ++requestId.current
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
      if (token !== requestId.current) return
      setIssues((prev) => (append && prev ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
    } catch (err) {
      if (token !== requestId.current) return
      setError(err)
    } finally {
      if (token === requestId.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, status])

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (typing) return
      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === 'n' && catalog.projects.length > 0) {
        event.preventDefault()
        setCreateOpen(true)
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && listRef.current) {
        const links = Array.from(listRef.current.querySelectorAll<HTMLElement>('a.task-card, a.row'))
        if (links.length === 0) return
        const index = links.findIndex((el) => el === document.activeElement)
        event.preventDefault()
        const nextIndex =
          event.key === 'ArrowDown'
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
  }, [catalog.projects.length])

  const profilesById = useMemo(() => {
    const map = new Map<string, Profile>()
    for (const profile of profilesQuery.data?.items ?? []) map.set(profile.id, profile)
    return map
  }, [profilesQuery.data])

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of catalog.projects) map.set(project.id, project)
    return map
  }, [catalog.projects])

  const visible = useMemo(() => {
    if (!issues) return null
    const query = search.trim().toLowerCase()
    if (!query) return issues
    return issues.filter((issue) => issue.title.toLowerCase().includes(query) || issue.id.toLowerCase().includes(query))
  }, [issues, search])

  const grouped = useMemo(() => {
    const buckets = new Map<string, IssueListItem[]>()
    for (const column of BOARD_COLUMNS) buckets.set(column.id, [])
    for (const issue of visible ?? []) {
      const bucket = buckets.get(columnForStatus(issue.status))
      bucket?.push(issue)
    }
    for (const items of buckets.values()) items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return buckets
  }, [visible])

  const projects = catalog.projects
  const noProjects = !catalog.loading && projects.length === 0
  const currentProject = projectId ? projectsById.get(projectId) : undefined

  function taskLink(issue: { id: string }) {
    const next = new URLSearchParams()
    if (projectId) next.set('project', projectId)
    if (view === 'list') next.set('view', 'list')
    const searchText = next.toString()
    return `/issues/${encodeURIComponent(issue.id)}${searchText ? `?${searchText}` : ''}`
  }

  return (
    <div className="board-screen">
      <div className="command">
        <span className="command-title">{currentProject ? currentProject.name : '任务'}</span>
        <span className="seg" role="group" aria-label="查看方式">
          <button type="button" aria-pressed={view === 'board'} onClick={() => setParam('view', '')}>
            <LayoutGrid size={15} strokeWidth={1.75} aria-hidden="true" />
            看板
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setParam('view', 'list')}>
            <List size={15} strokeWidth={1.75} aria-hidden="true" />
            列表
          </button>
        </span>
        <span style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360, display: 'flex' }}>
          <Search size={15} strokeWidth={1.75} aria-hidden="true" style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ink-3)' }} />
          <input
            ref={searchRef}
            className="input search"
            style={{ paddingLeft: 30 }}
            type="search"
            placeholder="搜索标题或编号（/）"
            value={search}
            onChange={(event) => setParam('q', event.target.value)}
            aria-label="搜索任务"
          />
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setProjectsOpen(true)}>
          管理项目
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)} disabled={noProjects} title={noProjects ? '请先创建项目' : '新建任务（n）'}>
          <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
          新建任务
        </button>
      </div>

      <div className="board-scroll" ref={listRef}>
        {catalog.error ? <ErrorBox error={catalog.error} onRetry={catalog.refetch} /> : null}
        {noProjects ? (
          <EmptyState
            title="还没有项目"
            hint="任务属于一个项目。Git 仓库和普通目录都可以。先创建项目，再新建任务。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => setProjectsOpen(true)}>
                创建项目
              </button>
            }
          />
        ) : (
          <>
            {view === 'list' ? (
              <div className="chips" style={{ marginBottom: 12 }} role="group" aria-label="按状态筛选">
                {STATUS_FILTERS.map((item) => (
                  <button key={item.value} type="button" className="chip" aria-pressed={status === item.value} onClick={() => setParam('status', item.value)}>
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
            {loading ? (
              <LoadingBlock label="正在加载任务…" />
            ) : visible && visible.length > 0 ? (
              view === 'board' ? (
                <div className="board">
                  {BOARD_COLUMNS.map((column) => {
                    const items = grouped.get(column.id) ?? []
                    const latest = items[0]
                    return (
                      <section key={column.id} className="board-col" aria-label={column.label}>
                        <div className="board-col-head">
                          <div className="board-col-title">
                            <span>{column.label}</span>
                            <span className="col-count">{items.length}</span>
                          </div>
                          <div className="board-col-hint">
                            {column.hint}
                            {latest ? ` · 最近 ${timeAgo(latest.updatedAt)}` : ''}
                          </div>
                        </div>
                        {items.map((issue) => (
                          <TaskCard key={issue.id} issue={issue} profile={issue.dispatch.profileId ? profilesById.get(issue.dispatch.profileId) : undefined} project={projectId ? undefined : projectsById.get(issue.projectId)} to={taskLink(issue)} />
                        ))}
                      </section>
                    )
                  })}
                </div>
              ) : (
                <div className="rows">
                  {visible.map((issue) => {
                    const meta = issueBoardMeta(issue)
                    const profile = issue.dispatch.profileId ? profilesById.get(issue.dispatch.profileId) : undefined
                    const project = projectsById.get(issue.projectId)
                    return (
                      <Link key={issue.id} className="row" to={taskLink(issue)}>
                        <Dot color={meta.color} />
                        <div className="row-main">
                          <div className="row-title">
                            <span className="t">{issue.title}</span>
                          </div>
                          <div className="row-meta">
                            {project ? <span>{project.name}</span> : null}
                            <Owner profile={profile} />
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
              )
            ) : (
              <EmptyState
                title={search || status ? '没有符合条件的任务' : '还没有任务'}
                hint={search || status ? '换一个条件，或清空搜索。' : '新建一张任务，写清要完成的事和怎样算做完。'}
                action={
                  search || status ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const next = new URLSearchParams(params)
                        next.delete('q')
                        next.delete('status')
                        setParams(next, { replace: true })
                      }}
                    >
                      清空筛选
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                      新建任务
                    </button>
                  )
                }
              />
            )}
            {nextCursor && !loading ? (
              <div className="load-more">
                <button type="button" className="btn" onClick={() => void load(nextCursor)} disabled={loadingMore}>
                  {loadingMore ? '正在加载…' : '加载更多任务'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <CreateIssueDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects}
        profiles={profilesQuery.data?.items ?? []}
        defaultProjectId={projectId}
        onCreated={(issue) => {
          setCreateOpen(false)
          toast.notify('任务已创建')
          navigate(taskLink(issue))
        }}
      />
      <ProjectsDialog
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        projects={projects}
        onChanged={() => catalog.refetch()}
      />
    </div>
  )
}

function Owner({ profile }: { profile: Profile | undefined }) {
  if (!profile) return <span>自动分配</span>
  return (
    <span className="task-owner">
      <Avatar presetId={profile.avatarPresetId} size={18} label={profile.name} />
      <span>{profile.name}</span>
    </span>
  )
}

function TaskCard({ issue, profile, project, to }: { issue: IssueListItem; profile: Profile | undefined; project: Project | undefined; to: string }) {
  const meta = issueBoardMeta(issue)
  return (
    <Link className="task-card" to={to}>
      <div className="task-card-title">{issue.title}</div>
      <StatusPill label={meta.label} color={meta.color} />
      <div className="task-card-meta">
        <Owner profile={profile} />
        <span>{timeAgo(issue.updatedAt)}</span>
      </div>
      {project ? <div className="muted small">{project.name}</div> : null}
    </Link>
  )
}

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
  const [accessMode, setAccessMode] = useState<'read-only' | 'workspace-write'>('workspace-write')
  const [attendance, setAttendance] = useState<'manual' | 'bounded-unattended'>('manual')
  const [isolationRequirement, setIsolationRequirement] = useState<'trusted-host' | 'full'>('trusted-host')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [idemKey, setIdemKey] = useState('')
  const related = useProjectTasks(open ? projectId : '')

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
      setAccessMode('workspace-write')
      setAttendance('manual')
      setIsolationRequirement('trusted-host')
      setError(null)
      setIdemKey(newIdempotencyKey())
    }
  }, [open, defaultProjectId, projects])

  const enabledProfiles = profiles.filter((profile) => !profile.disabled)
  const valid = projectId && title.trim() && description.trim() && (mode === 'auto' || profileId)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const issue = await issuesApi.create(
        {
          projectId,
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: criteria.split('\n').map((line) => line.trim()).filter(Boolean),
          dispatch: mode === 'require' ? { mode: 'require', profileId } : { mode: 'auto', profileId: null },
          dependsOn: lines(dependsOn),
          ownedPaths: lines(ownedPaths),
          readOnlyPaths: lines(readOnlyPaths),
          accessMode,
          attendance,
          isolationRequirement,
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
    <Dialog open={open} onClose={onClose} title="新建任务" busy={busy}>
      <form onSubmit={submit} id="create-issue-form">
        <Field label="所属项目" htmlFor="ci-project">
          <select id="ci-project" className="select" value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标题" htmlFor="ci-title">
          <input id="ci-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} placeholder="一句话说明要完成什么" />
        </Field>
        <Field label="要做什么" htmlFor="ci-desc" hint="写清目标、已知输入和限制。越具体，越容易验收。">
          <textarea id="ci-desc" className="textarea" value={description} onChange={(event) => setDescription(event.target.value)} required rows={5} />
        </Field>
        <Field label="怎样算做完" htmlFor="ci-criteria" hint="每行一条。留空表示没有单独列出的标准。">
          <textarea id="ci-criteria" className="textarea" value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={3} placeholder={'能复现原来的问题\n回归测试通过'} />
        </Field>
        <Field label="谁来执行" htmlFor="ci-mode">
          <select id="ci-mode" className="select" value={mode} onChange={(event) => setMode(event.target.value as 'require' | 'auto')}>
            <option value="auto">自动分配（由调度选择执行配置）</option>
            <option value="require">指定执行配置</option>
          </select>
        </Field>
        {mode === 'require' ? (
          <Field label="执行配置" htmlFor="ci-profile">
            {enabledProfiles.length === 0 ? (
              <div className="notice-box">还没有可用的执行配置。先去创建一个，或改成自动分配。</div>
            ) : (
              <select id="ci-profile" className="select" value={profileId} onChange={(event) => setProfileId(event.target.value)} required>
                <option value="" disabled>
                  选择执行配置
                </option>
                {enabledProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}（{profile.providerRef} / {profile.modelId}）
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <PlanFields
          prefix="ci"
          dependsOn={dependsOn}
          ownedPaths={ownedPaths}
          readOnlyPaths={readOnlyPaths}
          accessMode={accessMode}
          attendance={attendance}
          isolationRequirement={isolationRequirement}
          onDependsOn={setDependsOn}
          onOwnedPaths={setOwnedPaths}
          onReadOnlyPaths={setReadOnlyPaths}
          onAccessMode={setAccessMode}
          onAttendance={setAttendance}
          onIsolationRequirement={setIsolationRequirement}
          projectTasks={related.tasks.map((task) => ({ id: task.id, title: task.title }))}
          tasksLoading={related.loading}
          tasksFailed={related.failed}
        />
        {error ? <ErrorBox error={error} /> : null}
      </form>
      <div className="dialog-foot" style={{ margin: '0 -18px -16px', paddingTop: 12 }}>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="submit" form="create-issue-form" className="btn btn-primary" disabled={!valid || busy}>
          {busy ? '正在创建…' : '创建任务'}
        </button>
      </div>
    </Dialog>
  )
}

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

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !rootPath.trim() || busy) return
    setBusy(true)
    setError(null)
    const input: CreateProjectInput = { name: name.trim(), kind, rootPath: rootPath.trim() }
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
        <p className="muted small">还没有项目。在下面创建第一个。</p>
      ) : (
        <ul className="list-plain" aria-label="项目列表">
          {projects.map((project) => (
            <li key={project.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <strong>{project.name}</strong>
                <span className="muted">{project.kind === 'git' ? 'Git 仓库' : '普通目录'}</span>
              </div>
              <div className="muted mono" style={{ overflowWrap: 'anywhere' }}>
                {project.rootPath}
              </div>
            </li>
          ))}
        </ul>
      )}
      <hr className="divider" />
      <h2 className="section-title" style={{ fontSize: 15 }}>
        新建项目
      </h2>
      <form onSubmit={submit} id="create-project-form">
        <Field label="名称" htmlFor="cp-name">
          <input id="cp-name" className="input" value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="项目类型" htmlFor="cp-kind">
          <select id="cp-kind" className="select" value={kind} onChange={(event) => setKind(event.target.value as WorkspaceKind)}>
            <option value="git">Git 仓库</option>
            <option value="files">普通目录</option>
          </select>
        </Field>
        <Field label="本机路径" htmlFor="cp-root" hint="这是服务所在电脑上的路径，只供服务使用。">
          <input id="cp-root" className="input mono" value={rootPath} onChange={(event) => setRootPath(event.target.value)} required placeholder="例如 C:\\work\\my-repo" />
        </Field>
        {kind === 'git' ? (
          <Field label="目标分支（可选）" htmlFor="cp-branch">
            <input id="cp-branch" className="input mono" value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} placeholder="main" />
          </Field>
        ) : null}
        <Field label="验证命令（可选）" htmlFor="cp-verify" hint="准备候选和确认写入时会执行，例如测试脚本。">
          <input id="cp-verify" className="input mono" value={verifyCmd} onChange={(event) => setVerifyCmd(event.target.value)} placeholder="npm test" />
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
