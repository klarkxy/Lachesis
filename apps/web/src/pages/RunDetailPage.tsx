import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { issuesApi, profilesApi, runsApi } from '@/api/client'
import { useEventStream, useNow, useQuery } from '@/api/hooks'
import type { IssueEvent } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { QuestionCard } from '@/components/QuestionCard'
import {
  Dot,
  EmptyState,
  ErrorBox,
  IdTag,
  JsonDetails,
  LoadingBlock,
  StatusPill,
} from '@/components/ui'
import { issueStatusMeta, runStatusMeta } from '@/lib/status'
import { formatClock, formatDateTime, formatDuration } from '@/lib/time'

const ACTIVE_RUN = new Set(['starting', 'running', 'needs_input', 'cancelling'])

export function RunDetailPage() {
  const { runId = '' } = useParams()
  const runQuery = useQuery(() => runsApi.detail(runId), [runId])
  const run = runQuery.data?.run ?? null

  const issueQuery = useQuery(
    () => (run ? issuesApi.detail(run.issueId) : Promise.reject(new Error('no run'))),
    [run?.issueId],
  )
  const profilesQuery = useQuery(() => profilesApi.list(), [])

  const issue = issueQuery.data?.issue ?? null
  const stream = useEventStream(issue?.projectId, issue !== null)
  const runEvents = useMemo(() => stream.events.filter((e) => e.runId === runId), [stream.events, runId])
  const latestRunEventSequence = runEvents.at(-1)?.sequence ?? null
  useEffect(() => {
    if (latestRunEventSequence === null) return
    const timer = setTimeout(() => {
      runQuery.refetch()
      issueQuery.refetch()
    }, 250)
    return () => clearTimeout(timer)
  }, [latestRunEventSequence, runId])
  const questions = useMemo(
    () => (issueQuery.data?.questions ?? []).filter((q) => q.runId === runId),
    [issueQuery.data, runId],
  )

  const active = run !== null && ACTIVE_RUN.has(run.status)
  const now = useNow(active)

  if (runQuery.loading) {
    return (
      <div className="page">
        <LoadingBlock label="正在加载实例…" />
      </div>
    )
  }
  if (runQuery.error || !runQuery.data || !run) {
    return (
      <div className="page">
        <ErrorBox error={runQuery.error ?? new Error('实例不存在')} onRetry={runQuery.refetch} />
      </div>
    )
  }

  const meta = runStatusMeta(run.status)
  const profile = profilesQuery.data?.items.find((p) => p.id === run.profileId) ?? null
  const duration = formatDuration(run.startedAt, run.endedAt, now)
  const facts = Object.entries(runQuery.data.facts)

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="meta-line" style={{ marginTop: 0, marginBottom: 4 }}>
            {issue ? <Link to={`/issues/${encodeURIComponent(issue.id)}`}>工单</Link> : <span>工单</span>}
            <span aria-hidden="true">/</span>
            <span>执行实例</span>
            <IdTag value={run.id} />
          </div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {profile ? (
              <>
                <Avatar presetId={profile.avatarPresetId} size={34} label={profile.name} />
                {profile.name}
                <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                  · 第 {run.attempt} 次执行
                </span>
              </>
            ) : (
              `第 ${run.attempt} 次执行`
            )}
          </h1>
          <div className="meta-line">
            <StatusPill label={meta.label} color={meta.color} strong />
            {issue ? (
              <Link to={`/issues/${encodeURIComponent(issue.id)}`}>{issue.title}</Link>
            ) : (
              <IdTag value={run.issueId} title="工单" />
            )}
            {duration ? <span>已运行 {duration}</span> : null}
          </div>
        </div>
        <div className="head-actions">
          {issue ? (
            <Link className="btn" to={`/issues/${encodeURIComponent(issue.id)}`}>
              返回工单
            </Link>
          ) : null}
        </div>
      </div>

      {questions.length > 0 ? (
        <section aria-label="待答复提问" style={{ marginBottom: 16 }}>
          <div className="notice-box" style={{ marginBottom: 8 }}>
            此实例正在等待输入。
          </div>
          {questions.map((q) => (
            <QuestionCard key={q.id} question={q} onAnswered={() => issueQuery.refetch()} />
          ))}
        </section>
      ) : null}

      <div className="cols">
        <div>
          <section className="panel" aria-label="执行事实">
            <h2 className="section-title">执行事实</h2>
            <dl className="kv">
              <dt>状态</dt>
              <dd>{meta.label}</dd>
              <dt>配置快照</dt>
              <dd>
                {profile ? (
                  <Link to={`/profiles/${encodeURIComponent(profile.id)}`}>{profile.name}</Link>
                ) : (
                  <IdTag value={run.profileId} />
                )}{' '}
                <span className="mono muted">修订 r{run.profileRevision}</span>
              </dd>
              <dt>供应商 / 模型</dt>
              <dd className="mono">
                {run.providerRef} / {run.modelId}
              </dd>
              <dt>思考强度</dt>
              <dd className="mono">{run.reasoningEffort ?? '供应商默认'}</dd>
              <dt>开始时间</dt>
              <dd>{run.startedAt ? formatDateTime(run.startedAt) : '尚未开始'}</dd>
              <dt>结束时间</dt>
              <dd>{run.endedAt ? formatDateTime(run.endedAt) : active ? '进行中' : '未记录'}</dd>
              {run.sessionId ? (
                <>
                  <dt>会话</dt>
                  <dd className="mono">{run.sessionId}</dd>
                </>
              ) : null}
              {run.baseRef ? (
                <>
                  <dt>基线引用</dt>
                  <dd className="mono">{run.baseRef}</dd>
                </>
              ) : null}
              <dt>工作区</dt>
              <dd className="mono" style={{ overflowWrap: 'anywhere' }}>
                {run.workspacePath}
              </dd>
            </dl>
            {facts.length > 0 ? (
              <>
                <hr className="divider" />
                <h3 className="field-label" style={{ marginBottom: 6 }}>
                  服务观测到的其他事实
                </h3>
                <JsonDetails data={runQuery.data.facts} summary="查看观测事实" />
              </>
            ) : null}
            <p className="muted small" style={{ marginBottom: 0 }}>
              仅展示服务实际观测到的状态与时间；没有真实进度模型时不显示完成百分比或预计剩余时间。
            </p>
          </section>

          <MessagePanel runId={run.id} active={active} />
        </div>

        <div>
          <RunEventsPanel
            runId={run.id}
            live={runEvents}
            connected={stream.connected}
            failed={stream.error}
            onReconnect={stream.reset}
          />

          {issue ? (
            <section className="panel" aria-label="所属工单状态">
              <h2 className="section-title">所属工单</h2>
              <dl className="kv">
                <dt>标题</dt>
                <dd>
                  <Link to={`/issues/${encodeURIComponent(issue.id)}`}>{issue.title}</Link>
                </dd>
                <dt>状态</dt>
                <dd>{issueStatusMeta(issue.status).label}</dd>
              </dl>
              <p className="muted small" style={{ marginBottom: 0 }}>
                取消或中止执行请在工单详情页操作；取消工单会向此实例发送取消信号。
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * 实例事件：持久事件页（GET /runs/:id/events，单调 sequence 游标）为基线，
 * SSE 增量去重合并；同一事件 ID 语义保证两者可安全拼接。
 */
function RunEventsPanel({
  runId,
  live,
  connected,
  failed,
  onReconnect,
}: {
  runId: string
  live: IssueEvent[]
  connected: boolean
  failed: boolean
  onReconnect: () => void
}) {
  const firstPage = useQuery(() => runsApi.events(runId), [runId])
  const [extra, setExtra] = useState<IssueEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)

  useEffect(() => {
    setExtra([])
    setMoreError(null)
  }, [runId])

  useEffect(() => {
    if (firstPage.data) setCursor(firstPage.data.nextCursor)
  }, [firstPage.data])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await runsApi.events(runId, cursor)
      setExtra((prev) => [...prev, ...page.items])
      setCursor(page.nextCursor)
    } catch (err) {
      setMoreError(err)
    } finally {
      setLoadingMore(false)
    }
  }

  const events = useMemo(() => {
    const bySequence = new Map<number, IssueEvent>()
    for (const event of firstPage.data?.items ?? []) bySequence.set(event.sequence, event)
    for (const event of extra) bySequence.set(event.sequence, event)
    for (const event of live) bySequence.set(event.sequence, event)
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence)
  }, [firstPage.data, extra, live])

  return (
    <section className="panel" aria-label="实例事件">
      <h2 className="section-title">
        事件 <span className="count">{events.length}</span>
        <span className={`pill${connected ? ' pill-strong' : ''}`} role="status">
          <Dot color={connected ? 'var(--st-ok)' : 'var(--st-off)'} />
          {connected ? '实时连接中' : '未连接'}
        </span>
      </h2>
      {failed && !connected ? (
        <div className="notice-box" style={{ marginBottom: 8 }}>
          实时事件连接中断，正在自动重连；历史事件已从持久记录补齐。也可以
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReconnect}>
            立即重连
          </button>
        </div>
      ) : null}
      {firstPage.loading ? (
        <LoadingBlock label="正在加载事件…" />
      ) : firstPage.error ? (
        <ErrorBox error={firstPage.error} onRetry={firstPage.refetch} />
      ) : events.length === 0 ? (
        <p className="muted small">还没有此实例的事件记录。</p>
      ) : (
        <div className="events">
          {[...events].reverse().map((event) => (
            <div className="event" key={event.sequence}>
              <span className="event-time" title={formatDateTime(event.createdAt)}>
                {formatClock(event.createdAt)}
              </span>
              <div>
                <span className="event-type">{event.type}</span>
                {event.data !== null && event.data !== undefined ? (
                  <JsonDetails data={event.data} summary="详情" />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {moreError ? <ErrorBox error={moreError} /> : null}
      {cursor ? (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? '正在加载…' : '加载更多持久事件'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function MessagePanel({ runId, active }: { runId: string; active: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [report, setReport] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const result = await runsApi.sendMessage(runId, text.trim())
      setText('')
      setReport(
        result.delivered
          ? '消息已存储并送达实例。'
          : '消息已存储；实例当前不在接收状态，将在其可读时读取。',
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-label="向实例发送消息">
      <h2 className="section-title">发送消息</h2>
      {active ? (
        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 8 }}>
            <label className="field-label" htmlFor="run-message">
              补充指令或上下文
            </label>
            <textarea
              id="run-message"
              className="textarea"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {error ? <ErrorBox error={error} /> : null}
          {report ? (
            <div className="ok-box" role="status">
              {report}
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy}>
              {busy ? '正在发送…' : '发送'}
            </button>
          </div>
        </form>
      ) : (
        <EmptyState title="实例已结束" hint="消息只能在实例运行期间发送。执行记录与交付保留在工单详情页。" />
      )}
    </section>
  )
}
