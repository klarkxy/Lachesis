import { useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { sessionApi } from '@/api/client'
import { onSessionExpired } from '@/api/session'
import { BrandMark, LoadingBlock } from '@/components/ui'
import { SetupPage } from '@/pages/SetupPage'
import { IssuesPage } from '@/pages/IssuesPage'
import { DispatchPage } from '@/pages/DispatchPage'
import { IssueDetailPage } from '@/pages/IssueDetailPage'
import { RunDetailPage } from '@/pages/RunDetailPage'
import { ProfilesPage } from '@/pages/ProfilesPage'
import { ProfileDetailPage } from '@/pages/ProfileDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { EmptyState } from '@/components/ui'

function navIcon(kind: 'issues' | 'dispatch' | 'profiles' | 'settings') {
  const common = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, 'aria-hidden': true }
  if (kind === 'issues') {
    return (
      <svg {...common}>
        <path d="M3 4.5h10M3 8h10M3 11.5h6" />
      </svg>
    )
  }
  if (kind === 'profiles') {
    return (
      <svg {...common}>
        <circle cx="8" cy="5.5" r="2.8" />
        <path d="M2.8 13.5c.7-2.6 2.7-4 5.2-4s4.5 1.4 5.2 4" />
      </svg>
    )
  }
  if (kind === 'dispatch') {
    return <svg {...common}><path d="M2 4h12M2 8h8M2 12h5" /><circle cx="12" cy="9" r="2" /></svg>
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" />
    </svg>
  )
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <BrandMark />
          <span>
            <span className="brand-name">Lachesis</span>
            <span className="brand-sub">工单执行管理</span>
          </span>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <NavLink to="/issues">{navIcon('issues')}工单</NavLink>
          <NavLink to="/dispatch">{navIcon('dispatch')}调度</NavLink>
          <NavLink to="/profiles">{navIcon('profiles')}Profile</NavLink>
          <NavLink to="/settings">{navIcon('settings')}设置</NavLink>
        </nav>
        <div className="side-foot">Lachesis Web</div>
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
        // 网络错误不当作未配对：保持可重试的检查态由 SetupPage 报告
        if (!cancelled) setSession('unpaired')
      })
    return onSessionExpired(() => {
      if (!cancelled) setSession('unpaired')
    })
  }, [])

  if (session === 'checking') {
    return <LoadingBlock label="正在连接 Lachesis 服务…" />
  }

  const onSetup = session === 'unpaired'

  if (onSetup) return <SetupPage onPaired={() => setSession('ready')} />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/issues" replace />} />
        <Route path="/issues" element={<IssuesPage />} />
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/issues/:issueId" element={<IssueDetailPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/profiles/:profileId" element={<ProfileDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <div className="page">
              <EmptyState title="页面不存在" hint="请从左侧导航进入工单或 Profile。" />
            </div>
          }
        />
      </Routes>
    </Layout>
  )
}
