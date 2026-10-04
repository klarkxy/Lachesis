import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { CalendarClock, Folder, FolderGit2, Kanban, Settings, SlidersHorizontal } from 'lucide-react'
import { sessionApi } from '@/api/client'
import { onSessionExpired } from '@/api/session'
import { ProjectCatalogProvider, useProjectCatalog } from '@/components/ProjectCatalog'
import { BrandMark, EmptyState, ErrorBox, LoadingBlock } from '@/components/ui'
import { SetupPage } from '@/pages/SetupPage'
import { IssuesPage } from '@/pages/IssuesPage'
import { DispatchPage } from '@/pages/DispatchPage'
import { RunDetailPage } from '@/pages/RunDetailPage'

const IssueDetailPage = lazy(() => import('@/pages/IssueDetailPage').then((module) => ({ default: module.IssueDetailPage })))
import { ProfilesPage } from '@/pages/ProfilesPage'
import { ProfileDetailPage } from '@/pages/ProfileDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'

function Layout({ children }: { children: React.ReactNode }) {
  const catalog = useProjectCatalog()
  const location = useLocation()
  const navigate = useNavigate()
  const projectId = new URLSearchParams(location.search).get('project') ?? ''
  const onTasks = location.pathname === '/issues' || location.pathname.startsWith('/issues/')

  function chooseProject(id: string) {
    const onBoard = location.pathname === '/issues'
    if (onBoard) {
      const next = new URLSearchParams(location.search)
      if (id) next.set('project', id)
      else next.delete('project')
      navigate({ pathname: '/issues', search: next.toString() }, { replace: true })
      return
    }
    navigate({ pathname: '/issues', search: id ? `?project=${encodeURIComponent(id)}` : '' })
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <BrandMark />
          <span>
            <span className="brand-name">Lachesis</span>
            <span className="brand-sub">本地任务执行</span>
          </span>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <NavLink to="/issues">
            <Kanban size={16} strokeWidth={1.75} aria-hidden="true" />
            任务
          </NavLink>
          <NavLink to="/profiles">
            <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
            执行配置
          </NavLink>
          <NavLink to="/dispatch">
            <CalendarClock size={16} strokeWidth={1.75} aria-hidden="true" />
            运行调度
          </NavLink>
          <NavLink to="/settings">
            <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
            设置
          </NavLink>
        </nav>
        <div className="rail-label" id="project-rail-label">项目</div>
        <ul className="project-rail" aria-labelledby="project-rail-label">
          <li>
            <button type="button" className={onTasks && !projectId ? 'project-item active' : 'project-item'} aria-current={onTasks && !projectId ? 'true' : undefined} onClick={() => chooseProject('')}>
              全部项目
            </button>
          </li>
          {catalog.loading && catalog.projects.length === 0 ? <li className="muted small" style={{ padding: '4px 8px' }}>正在读取项目…</li> : null}
          {catalog.error ? <li><ErrorBox error={catalog.error} onRetry={catalog.refetch} /></li> : null}
          {catalog.projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={onTasks && projectId === project.id ? 'project-item active' : 'project-item'}
                aria-current={onTasks && projectId === project.id ? 'true' : undefined}
                onClick={() => chooseProject(project.id)}
                title={project.kind === 'git' ? 'Git 项目' : '普通目录项目'}
              >
                {project.kind === 'git' ? <FolderGit2 size={15} strokeWidth={1.75} aria-hidden="true" /> : <Folder size={15} strokeWidth={1.75} aria-hidden="true" />}
                <span className="project-name">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="side-foot">本机工作台</div>
      </aside>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  )
}

type SessionState = 'checking' | 'ready' | 'unpaired'

export default function App() {
  const [session, setSession] = useState<SessionState>('checking')

  useEffect(() => {
    let cancelled = false
    sessionApi
      .probe()
      .then((ok) => {
        if (!cancelled) setSession(ok ? 'ready' : 'unpaired')
      })
      .catch(() => {
        if (!cancelled) setSession('unpaired')
      })
    return onSessionExpired(() => {
      if (!cancelled) setSession('unpaired')
    })
  }, [])

  if (session === 'checking') {
    return <LoadingBlock label="正在连接 Lachesis 服务…" />
  }

  if (session === 'unpaired') return <SetupPage onPaired={() => setSession('ready')} />

  return (
    <ProjectCatalogProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/issues" replace />} />
          <Route path="/issues" element={<IssuesPage />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/issues/:issueId" element={<Suspense fallback={<LoadingBlock label="正在打开任务…" />}><IssueDetailPage /></Suspense>} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/profiles/:profileId" element={<ProfileDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <div className="page">
                <EmptyState title="页面不存在" hint="从左侧进入任务、执行配置、运行调度或设置。" />
              </div>
            }
          />
        </Routes>
      </Layout>
    </ProjectCatalogProvider>
  )
}
