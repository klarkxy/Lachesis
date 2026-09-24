import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  applicationsApi,
  isConflict,
  issuesApi,
  newIdempotencyKey,
  profilesApi,
  runsApi,
  deliveryFileUrl,
  checkpointFileUrl,
} from '@/api/client'
import { useEventStream, useNow, useQuery } from '@/api/hooks'
import type {
  Application,
  Delivery,
  IssueDetail,
  Profile,
  Run,
  RunCheckpoint,
} from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { Dialog } from '@/components/Dialog'
import { PlanFields, lines } from '@/components/PlanFields'
import { QuestionCard } from '@/components/QuestionCard'
import { useToast } from '@/components/Toast'
import {
  Dot,
  EmptyState,
  ErrorBox,
  Field,
  IdTag,
  JsonDetails,
  LoadingBlock,
  StatusPill,
} from '@/components/ui'
import {
  applicationStatusMeta,
  EVIDENCE_KIND,
  EVIDENCE_OUTCOME,
  FILE_CHANGE_KIND,
  issueStatusMeta,
  runStatusMeta,
} from '@/lib/status'
import { formatBytes, formatClock, formatDateTime, formatDuration, timeAgo } from '@/lib/time'

function visibleAssistantReply(text: string): string {
  return text
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*$/gi, '')
    .trim()
}

const TERMINAL_ISSUE = new Set(['accepted', 'failed', 'cancelled', 'recovery_required'])

export function IssueDetailPage() {
  const { issueId = '' } = useParams()
  const toast = useToast()
  const detail = useQuery(() => issuesApi.detail(issueId), [issueId])
  const profiles = useQuery(() => profilesApi.list(), [])

  const profilesById = useMemo(() => {
    const map = new Map<string, Profile>()
    for (const p of profiles.data?.items ?? []) map.set(p.id, p)
    return map
  }, [profiles.data])

  const issue = detail.data?.issue ?? null
  const stream = useEventStream(issue?.projectId, issue !== null)
  const runIds = useMemo(() => new Set((detail.data?.runs ?? []).map((r) => r.id)), [detail.data])
  const issueEvents = useMemo(
    () => stream.events.filter((e) => e.issueId === issueId || (e.runId !== null && runIds.has(e.runId))),
    [stream.events, issueId, runIds],
  )
  const latestEventSequence = issueEvents.at(-1)?.sequence ?? null
  useEffect(() => {
    if (latestEventSequence === null) return
    const timer = setTimeout(() => detail.refetch(), 250)
    return () => clearTimeout(timer)
  }, [latestEventSequence, issueId])

  // 最近一次 issue.failed 事件携带的诊断（由服务端持久事件提供）。
  const failureDiagnostic = useMemo(() => {
    if (!issue || issue.status !== 'failed') return null
    for (let i = issueEvents.length - 1; i >= 0; i -= 1) {
      const event = issueEvents[i]
      if (event?.type === 'issue.failed') {
        const data = event.data
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const diagnostic = (data as Record<string, unknown>)['diagnostic']
          if (typeof diagnostic === 'string' && diagnostic) return diagnostic
        }
        return null
      }
    }
    return null
  }, [issue, issueEvents])

  const [dialog, setDialog] = useState<'cancel' | 'retry' | 'accept' | 'rework' | 'evaluate' | 'integrate' | null>(null)

  function handleActionError(err: unknown): boolean {
    if (isConflict(err)) {
      toast.notifyError('工单状态已变化（版本冲突），已刷新最新数据。')
      detail.refetch()
      return true
    }
    return false
  }

  if (detail.loading) {
    return (
      <div className="page">
        <LoadingBlock label="正在加载工单…" />
      </div>
    )
  }
  if (detail.error || !detail.data || !issue) {
    return (
      <div className="page">
        <ErrorBox error={detail.error ?? new Error('工单不存在')} onRetry={detail.refetch} />
      </div>
    )
  }

  const data = detail.data
  const meta = issueStatusMeta(issue.status)
  const dispatchProfile = issue.dispatch.profileId ? profilesById.get(issue.dispatch.profileId) : undefined
  const canCancel = !TERMINAL_ISSUE.has(issue.status)
  const canRetry = issue.status === 'failed'
  const canReview = issue.status === 'awaiting_review'
  const canEvaluate = data.runs.length > 0 && issue.status !== 'cancelled'
  const canIntegrate = data.deliveries.length > 0 && issue.status === 'accepted'

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="meta-line" style={{ marginTop: 0, marginBottom: 4 }}>
            <Link to="/issues">工单</Link>
            <span aria-hidden="true">/</span>
            <IdTag value={issue.id} />
            <StatusPill label={meta.label} color={meta.color} strong />
          </div>
          <h1 className="page-title">{issue.title}</h1>
          <div className="meta-line">
            <span>创建于 {formatDateTime(issue.createdAt)}</span>
            <span>更新于 {timeAgo(issue.updatedAt)}</span>
            <span>来源 {issue.requesterRef}</span>
            <span className="mono">版本 v{issue.version}</span>
          </div>
        </div>
        <div className="head-actions">
          {canRetry ? (
            <button type="button" className="btn btn-primary" onClick={() => setDialog('retry')}>
              重试工单
            </button>
          ) : null}
          {canReview ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setDialog('accept')}>
                验收交付
              </button>
              <button type="button" className="btn" onClick={() => setDialog('rework')}>
                返工
              </button>
            </>
          ) : null}
          {canIntegrate ? (
            <button type="button" className="btn" onClick={() => setDialog('integrate')}>
              发起集成
            </button>
          ) : null}
          {canCancel ? (
            <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
              取消工单
            </button>
          ) : null}
        </div>
      </div>

      {issue.status === 'failed' ? (
        <div className="error-box" role="alert" style={{ marginBottom: 16 }}>
          <div>工单执行失败，已停止调度。确认原因后可使用「重试工单」重新入队；历史执行与交付保留可查。</div>
          {failureDiagnostic ? (
            <div className="small" style={{ marginTop: 4 }}>
              诊断：{failureDiagnostic}
            </div>
          ) : null}
        </div>
      ) : null}

      {issue.status === 'recovery_required' ? (
        <div className="error-box" role="alert" style={{ marginBottom: 16 }}>
          工作进程范围退出尚未得到可靠确认，工单已停止调度。重启服务本身不会解除此状态；请核对诊断、保留的工作区与备份，并取得进程范围已退出的可验证证据后再恢复。
        </div>
      ) : null}

      {data.questions.length > 0 ? (
        <section aria-label="待答复提问" style={{ marginBottom: 16 }}>
          <div className="notice-box" style={{ marginBottom: 8 }}>
            执行实例正在等待输入，答复后工单才会继续。
          </div>
          {data.questions.map((q) => (
            <QuestionCard key={q.id} question={q} onAnswered={() => detail.refetch()} />
          ))}
        </section>
      ) : null}

      <div className="cols">
        <div>
          <TaskPanel data={data} dispatchProfile={dispatchProfile} />
          <PlanEditor key={issue.id} data={data} onChanged={detail.refetch} onConflict={handleActionError} />
          <CommentsPanel data={data} onChanged={() => detail.refetch()} onConflict={handleActionError} />
          <EventsPanel events={issueEvents} connected={stream.connected} failed={stream.error} onReconnect={stream.reset} />
        </div>
        <div>
          <RunsPanel runs={data.runs} currentRunId={issue.currentRunId} profilesById={profilesById} />
          <CheckpointsPanel key={issue.id} data={data} onChanged={detail.refetch} onConflict={handleActionError} />
          <DeliveriesPanel
            deliveries={data.deliveries}
            issue={data.issue}
            onAccept={() => setDialog('accept')}
            onRework={() => setDialog('rework')}
          />
          <EvaluationPanel data={data} onEvaluate={() => setDialog('evaluate')} canEvaluate={canEvaluate} />
          <ApplicationsPanel
            key={issue.id}
            applications={data.applications}
            onChanged={() => detail.refetch()}
          />
        </div>
      </div>

      <CancelDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('已请求取消')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
      <RetryDialog
        open={dialog === 'retry'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('工单已重新入队')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
      <AcceptDialog
        open={dialog === 'accept'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('交付已验收')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
      <ReworkDialog
        open={dialog === 'rework'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('已发回返工')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
      <EvaluateDialog
        open={dialog === 'evaluate'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('评价已保存')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
      <IntegrateDialog
        open={dialog === 'integrate'}
        onClose={() => setDialog(null)}
        data={data}
        onDone={() => {
          setDialog(null)
          toast.notify('已创建集成候选')
          detail.refetch()
        }}
        onConflict={handleActionError}
      />
    </div>
  )
}

// ---------- 任务要求 ----------

function TaskPanel({ data, dispatchProfile }: { data: IssueDetail; dispatchProfile: Profile | undefined }) {
  const { issue } = data
  return (
    <section className="panel" aria-label="任务要求">
      <h2 className="section-title">任务要求</h2>
      <p style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{issue.description}</p>
      {issue.acceptanceCriteria.length > 0 ? (
        <>
          <h3 className="field-label" style={{ marginBottom: 6 }}>
            验收标准
          </h3>
          <ul className="list-plain checklist">
            {issue.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">未填写显式验收标准。</p>
      )}
      <hr className="divider" />
      <dl className="kv">
        <dt>执行方式</dt>
        <dd>
          {issue.dispatch.mode === 'require' ? (
            dispatchProfile ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Avatar presetId={dispatchProfile.avatarPresetId} size={18} label={dispatchProfile.name} />
                指定 {dispatchProfile.name}
              </span>
            ) : (
              <span>
                指定 Profile <IdTag value={issue.dispatch.profileId ?? ''} />
              </span>
            )
          ) : (
            '自动分配'
          )}
        </dd>
        {issue.dependsOn.length > 0 ? (
          <>
            <dt>依赖工单</dt>
            <dd style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {issue.dependsOn.map((dep) => (
                <Link key={dep} to={`/issues/${encodeURIComponent(dep)}`}>
                  <IdTag value={dep} />
                </Link>
              ))}
            </dd>
          </>
        ) : null}
        <dt>可修改路径</dt>
        <dd className="mono">{issue.ownedPaths?.length ? issue.ownedPaths.join('，') : '不限'}</dd>
        <dt>只读路径</dt>
        <dd className="mono">{issue.readOnlyPaths?.length ? issue.readOnlyPaths.join('，') : '无'}</dd>
        {issue.clientRequestId ? (
          <>
            <dt>调用方请求号</dt>
            <dd className="mono">{issue.clientRequestId}</dd>
          </>
        ) : null}
      </dl>
    </section>
  )
}

function PlanEditor({ data, onChanged, onConflict }: { data: IssueDetail; onChanged: () => void; onConflict: (error: unknown) => boolean }) {
  const { issue } = data
  const canEdit = (issue.status === 'queued' || issue.status === 'blocked') && data.runs.length === 0
  const [editing, setEditing] = useState(false)
  const [dependsOn, setDependsOn] = useState('')
  const [ownedPaths, setOwnedPaths] = useState('')
  const [readOnlyPaths, setReadOnlyPaths] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  function start() {
    setDependsOn(issue.dependsOn.join('\n'))
    setOwnedPaths((issue.ownedPaths ?? []).join('\n'))
    setReadOnlyPaths((issue.readOnlyPaths ?? []).join('\n'))
    setError(null)
    setEditing(true)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.updatePlan(issue.id, { expectedIssueVersion: issue.version,
        dependsOn: lines(dependsOn), ownedPaths: lines(ownedPaths), readOnlyPaths: lines(readOnlyPaths) })
      setEditing(false)
      onChanged()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit && !editing) return null
  return <section className="panel" aria-label="工单计划">
    <h2 className="section-title">工单计划</h2>
    {!editing ? <button type="button" className="btn btn-sm" onClick={start}>编辑依赖与路径</button> :
      <form onSubmit={(event) => void save(event)}>
        <PlanFields prefix="issue-plan" dependsOn={dependsOn} ownedPaths={ownedPaths} readOnlyPaths={readOnlyPaths}
          onDependsOn={setDependsOn} onOwnedPaths={setOwnedPaths} onReadOnlyPaths={setReadOnlyPaths} />
        {error ? <ErrorBox error={error} /> : null}
        {!canEdit ? <div className="notice-box">工单已有执行或状态变化，计划不能再编辑。请刷新工单。</div> : null}
        <div className="actions-row"><button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canEdit}>{busy ? '正在保存…' : '保存计划'}</button>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>取消</button></div>
      </form>}
  </section>
}

function CheckpointsPanel({ data, onChanged, onConflict }: { data: IssueDetail; onChanged: () => void; onConflict: (error: unknown) => boolean }) {
  const { issue, runs } = data
  const checkpoints = useQuery(() => issuesApi.checkpoints(issue.id), [issue.id])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const checkpointedRuns = new Set((checkpoints.data ?? []).map((checkpoint) => checkpoint.runId))
  const terminalRuns = runs.filter((run) => ['failed', 'cancelled', 'interrupted'].includes(run.status) && !checkpointedRuns.has(run.id))
  const canResume = issue.status === 'failed' || issue.status === 'cancelled'

  async function create(runId: string) {
    if (busy) return
    setBusy(runId)
    setError(null)
    try {
      await runsApi.checkpoint(runId)
      checkpoints.refetch()
    } catch (err) { setError(err) } finally { setBusy(null) }
  }

  async function resume(checkpoint: RunCheckpoint) {
    if (busy) return
    setBusy(checkpoint.id)
    setError(null)
    try {
      await issuesApi.resume(issue.id, checkpoint.id, issue.version)
      onChanged()
      checkpoints.refetch()
    } catch (err) { if (!onConflict(err)) setError(err) } finally { setBusy(null) }
  }

  return <section className="panel" aria-label="执行检查点">
    <h2 className="section-title">执行检查点 <span className="count">{checkpoints.data?.length ?? 0}</span></h2>
    <p className="muted small">检查点保存未完成文件；继续执行需要显式选择，检查点不能作为交付验收或应用。</p>
    {checkpoints.error ? <ErrorBox error={checkpoints.error} onRetry={checkpoints.refetch} /> : null}
    {error ? <ErrorBox error={error} /> : null}
    {terminalRuns.length > 0 ? <div className="actions-row">{terminalRuns.map((run) => <button key={run.id} type="button" className="btn btn-sm" disabled={busy !== null}
      onClick={() => void create(run.id)}>保存第 {run.attempt} 次执行的检查点</button>)}</div> : null}
    {checkpoints.loading && !checkpoints.data ? <LoadingBlock label="正在加载检查点…" /> : null}
    {checkpoints.data?.length ? <ul className="list-plain">{[...checkpoints.data].reverse().map((checkpoint) => <li key={checkpoint.id}>
      <div className="dispatch-project"><strong>检查点 {checkpoint.id.slice(0, 8)}</strong><span className="muted small">{formatDateTime(checkpoint.createdAt)}</span></div>
      <p className="muted small" style={{ margin: '4px 0' }}>{checkpoint.reason} · {checkpoint.files.length} 个文件</p>
      {checkpoint.files.map((file) => <div className="file-row" key={file.path}><span className={`file-kind file-kind-${file.kind}`}>{FILE_CHANGE_KIND[file.kind]}</span>
        <a className="mono" href={checkpointFileUrl(checkpoint.id, file.path)} download style={{ overflowWrap: 'anywhere' }}>{file.path}</a></div>)}
      {canResume ? <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void resume(checkpoint)}>从此检查点继续</button> : null}
    </li>)}</ul> : null}
  </section>
}

// ---------- 补充记录 ----------

function CommentsPanel({
  data,
  onChanged,
  onConflict,
}: {
  data: IssueDetail
  onChanged: () => void
  onConflict: (err: unknown) => boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [lastReport, setLastReport] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setLastReport(null)
    try {
      const result = await issuesApi.comment(data.issue.id, text.trim())
      setText('')
      setLastReport(result.report.delivered ? '已存储并送达执行实例。' : '已存储；实例当前不在接收状态，将在其可读时读取。')
      onChanged()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-label="补充说明">
      <h2 className="section-title">
        补充说明 <span className="count">{data.comments.length}</span>
      </h2>
      {data.comments.length > 0 ? (
        <ul className="list-plain" style={{ marginBottom: 12 }}>
          {data.comments.map((comment) => (
            <li key={comment.id}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{comment.text}</div>
              <div className="muted small">
                {comment.author ?? '操作员'} · {formatDateTime(comment.createdAt)}
                {comment.delivered === false ? ' · 未送达实例' : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">尚无补充说明。执行中可以在此追加要求，内容先持久存储。</p>
      )}
      <form onSubmit={submit}>
        <div className="field" style={{ marginBottom: 8 }}>
          <label className="field-label" htmlFor="comment-text">
            追加补充
          </label>
          <textarea
            id="comment-text"
            className="textarea"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {lastReport ? <div className="ok-box" role="status">{lastReport}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="submit" className="btn" disabled={!text.trim() || busy}>
            {busy ? '正在提交…' : '提交补充'}
          </button>
        </div>
      </form>
    </section>
  )
}

// ---------- 事件流 ----------

function EventsPanel({
  events,
  connected,
  failed,
  onReconnect,
}: {
  events: { sequence: number; type: string; data: unknown; createdAt: string; runId: string | null }[]
  connected: boolean
  failed: boolean
  onReconnect: () => void
}) {
  return (
    <section className="panel" aria-label="执行日志与事件">
      <h2 className="section-title">
        日志与事件 <span className="count">{events.length}</span>
        <span className={`pill${connected ? ' pill-strong' : ''}`} role="status">
          <Dot color={connected ? 'var(--st-ok)' : 'var(--st-off)'} />
          {connected ? '实时连接中' : '未连接'}
        </span>
      </h2>
      {failed && !connected ? (
        <div className="notice-box" style={{ marginBottom: 8 }}>
          实时事件连接中断，正在自动重连；也可以
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReconnect}>
            立即重连
          </button>
        </div>
      ) : null}
      {events.length === 0 ? (
        <p className="muted small">还没有记录到事件。工单被领取、执行与交付时，事件会出现在这里。</p>
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
    </section>
  )
}

// ---------- 执行 ----------

function RunsPanel({
  runs,
  currentRunId,
  profilesById,
}: {
  runs: Run[]
  currentRunId: string | null
  profilesById: Map<string, Profile>
}) {
  const anyActive = runs.some((r) => ['starting', 'running', 'needs_input'].includes(r.status))
  const now = useNow(anyActive)
  return (
    <section className="panel" aria-label="执行实例">
      <h2 className="section-title">
        执行 <span className="count">{runs.length}</span>
      </h2>
      {runs.length === 0 ? (
        <p className="muted small">工单尚未被领取执行。</p>
      ) : (
        <ul className="list-plain">
          {[...runs].reverse().map((run) => {
            const meta = runStatusMeta(run.status)
            const profile = profilesById.get(run.profileId)
            const duration = formatDuration(run.startedAt, run.endedAt, now)
            return (
              <li key={run.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Dot color={meta.color} />
                  <Link to={`/runs/${encodeURIComponent(run.id)}`}>
                    第 {run.attempt} 次执行
                  </Link>
                  {run.id === currentRunId ? <span className="pill pill-strong">当前</span> : null}
                  <span className="muted small" style={{ marginLeft: 'auto' }}>
                    {meta.label}
                    {duration ? ` · ${duration}` : ''}
                  </span>
                </div>
                <div className="row-meta" style={{ marginTop: 3 }}>
                  {profile ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Avatar presetId={profile.avatarPresetId} size={16} label={profile.name} />
                      {profile.name}
                      <span className="mono muted">配置修订 r{run.profileRevision}</span>
                    </span>
                  ) : (
                    <IdTag value={run.profileId} />
                  )}
                  <span className="mono muted">
                    {run.providerRef} / {run.modelId}
                    {run.reasoningEffort ? ` · 思考强度 ${run.reasoningEffort}` : ''}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------- 交付 ----------

function DeliveriesPanel({
  deliveries,
  issue,
  onAccept,
  onRework,
}: {
  deliveries: Delivery[]
  issue: IssueDetail['issue']
  onAccept: () => void
  onRework: () => void
}) {
  const canReview = issue.status === 'awaiting_review'
  return (
    <section className="panel" aria-label="交付记录">
      <h2 className="section-title">
        交付 <span className="count">{deliveries.length}</span>
      </h2>
      {deliveries.length === 0 ? (
        <p className="muted small">还没有交付记录。执行结束后交付会在此等待验收，不会自动完成。</p>
      ) : (
        [...deliveries].reverse().map((delivery) => (
          <article key={delivery.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <strong>交付</strong>
              <IdTag value={delivery.id} />
              {issue.acceptedDeliveryId === delivery.id ? <span className="pill pill-strong">已验收</span> : null}
              <span className="muted small" style={{ marginLeft: 'auto' }}>
                {timeAgo(delivery.createdAt)}
              </span>
            </div>
            <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>
              {visibleAssistantReply(delivery.summary) || visibleAssistantReply(delivery.finalResponse ?? '').slice(0, 1_000) || '交付已生成，请查看文件与证据。'}
            </p>
            {delivery.files.length > 0 ? (
              <div style={{ marginBottom: 8 }}>
                {delivery.files.map((file) => (
                  <div className="file-row" key={file.path}>
                    <span className={`file-kind file-kind-${file.kind}`}>{FILE_CHANGE_KIND[file.kind]}</span>
                    <a
                      className="mono"
                      href={deliveryFileUrl(delivery.id, file.path)}
                      download
                      style={{ flex: 1, overflowWrap: 'anywhere' }}
                    >
                      {file.path}
                    </a>
                    <span className="muted small">{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">无文件变更。</p>
            )}
            {delivery.evidence.length > 0 ? (
              <ul className="list-plain" style={{ marginBottom: 8 }}>
                {delivery.evidence.map((evidence, index) => {
                  const outcome = EVIDENCE_OUTCOME[evidence.outcome]
                  return (
                    <li key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <Dot color={outcome.color} />
                      <span>
                        {evidence.label}
                        <span className="muted">（{EVIDENCE_KIND[evidence.kind]} · {outcome.label}）</span>
                      </span>
                      {evidence.detail ? <span className="muted small">{evidence.detail}</span> : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {delivery.finalResponse ? <JsonDetails data={visibleAssistantReply(delivery.finalResponse)} summary="查看最终回复" /> : null}
            {canReview ? (
              <div className="actions-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={onAccept}>
                  验收
                </button>
                <button type="button" className="btn btn-sm" onClick={onRework}>
                  返工
                </button>
              </div>
            ) : null}
          </article>
        ))
      )}
    </section>
  )
}

// ---------- 评价 ----------

function EvaluationPanel({
  data,
  canEvaluate,
  onEvaluate,
}: {
  data: IssueDetail
  canEvaluate: boolean
  onEvaluate: () => void
}) {
  const evaluation = data.evaluation
  return (
    <section className="panel" aria-label="工单评价">
      <h2 className="section-title">评价</h2>
      {evaluation && evaluation.active ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <strong style={{ fontSize: 20 }}>{evaluation.score}</strong>
            <span className="muted small">/ 5 · 评价修订 r{evaluation.revision}</span>
          </div>
          {evaluation.comment ? <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}>{evaluation.comment}</p> : null}
          <div className="muted small">评价于 {formatDateTime(evaluation.createdAt)}，计入对应 Profile 履历。</div>
        </div>
      ) : (
        <p className="muted small">尚未评价。评分属于工单，并按配置修订聚合到 Profile；未评分不计入零分。</p>
      )}
      {canEvaluate ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn" onClick={onEvaluate}>
            {evaluation && evaluation.active ? '修改评价' : '评价工单'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

// ---------- 集成与应用 ----------

function ApplicationsPanel({
  applications,
  onChanged,
}: {
  applications: Application[]
  onChanged: () => void
}) {
  const toast = useToast()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function apply(application: Application) {
    if (busyId) return
    if (!window.confirm(`确认将交付显式应用到本地工作区？目标：${application.expectedTarget ?? '由服务决定'}`)) return
    setBusyId(application.id)
    setError(null)
    try {
      // 每次显式应用使用新的幂等键；同一次点击的重试由按钮禁用保护
      await applicationsApi.apply(application.id, application.expectedTarget, newIdempotencyKey())
      toast.notify('已请求应用')
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="panel" aria-label="集成与应用">
      <h2 className="section-title">
        集成与应用 <span className="count">{applications.length}</span>
      </h2>
      {error ? <ErrorBox error={error} /> : null}
      {applications.length === 0 ? (
        <p className="muted small">还没有集成候选。验收后可从交付发起集成，再由你显式应用到本地。</p>
      ) : (
        <ul className="list-plain">
          {[...applications].reverse().map((application) => {
            const meta = applicationStatusMeta(application.status)
            const canApply = application.status === 'ready'
            const troubled = ['failed', 'recovery_required', 'conflict'].includes(application.status)
            return (
              <li key={application.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Dot color={meta.color} />
                  <StatusPill label={meta.label} color={meta.color} />
                  <IdTag value={application.id} />
                  <span style={{ marginLeft: 'auto' }} className="actions-row">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded((current) => current === application.id ? null : application.id)} aria-expanded={expanded === application.id}>
                      {expanded === application.id ? '收起' : '详情'}
                    </button>
                    {canApply ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void apply(application)}
                        disabled={busyId === application.id}
                      >
                        {busyId === application.id ? '正在应用…' : '显式应用'}
                      </button>
                    ) : null}
                  </span>
                </div>
                <dl className="kv" style={{ marginTop: 6 }}>
                  <dt>目标</dt>
                  <dd className="mono">{application.expectedTarget ?? '未指定'}</dd>
                  {application.resultTarget ? (
                    <>
                      <dt>实际结果</dt>
                      <dd className="mono">{application.resultTarget}</dd>
                    </>
                  ) : null}
                </dl>
                {troubled && application.diagnostic ? (
                  <div className="error-box" style={{ marginTop: 6 }}>
                    {application.diagnostic}
                    {application.status === 'recovery_required' ? (
                      <div className="small" style={{ marginTop: 4 }}>
                        目标工作区可能处于中间状态。重启服务不会自动解除；请核对诊断、保留的候选与备份，取得可验证的恢复证据后再处理。
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {troubled && application.status !== 'recovery_required' ? <p className="muted small">检查诊断后，从交付创建新的集成候选。</p> : null}
                {expanded === application.id ? (
                  <ApplicationDiagnostics key={application.id} applicationId={application.id} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function ApplicationDiagnostics({ applicationId }: { applicationId: string }) {
  const detail = useQuery(() => applicationsApi.detail(applicationId), [applicationId])
  const verification = useQuery(() => applicationsApi.verification(applicationId), [applicationId])
  return <div style={{ marginTop: 8 }}>
    {detail.error ? <ErrorBox error={detail.error} onRetry={detail.refetch} /> : null}
    {detail.loading && !detail.data ? <LoadingBlock label="正在加载候选详情…" /> : null}
    {detail.data?.evidence.length ? <ul className="list-plain">{detail.data.evidence.map((evidence, index) => {
      const outcome = EVIDENCE_OUTCOME[evidence.outcome]
      return <li key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><Dot color={outcome.color} />
        <span>{evidence.label}<span className="muted">（{outcome.label}）</span></span>
        {evidence.detail ? <span className="muted small">{evidence.detail}</span> : null}</li>
    })}</ul> : detail.data ? <p className="muted small">此候选暂无验证证据记录。</p> : null}
    {verification.error ? <ErrorBox error={verification.error} onRetry={verification.refetch} /> : null}
    {verification.loading && !verification.data ? <LoadingBlock label="正在加载验证记录…" /> : null}
    {verification.data ? <details><summary>验证记录 · {verification.data.exitCode === 0 ? '通过' : '未通过'}</summary>
      <dl className="kv"><dt>命令</dt><dd className="mono">{verification.data.command.join(' ')}</dd>
        <dt>结束状态</dt><dd>{verification.data.exitCode === null ? '无退出码' : `退出码 ${verification.data.exitCode}`}{verification.data.signal ? ` · 信号 ${verification.data.signal}` : ''}</dd>
        <dt>时间</dt><dd>{formatDateTime(verification.data.startedAt)} — {formatDateTime(verification.data.finishedAt)}</dd></dl>
      <p className="small">{verification.data.summary}</p>
      {verification.data.truncated ? <p className="notice-box small">日志已截断，省略 {formatBytes(verification.data.omittedBytes)}；显示保留的开头和结尾。</p> : null}
      <pre className="verification-output">{verification.data.output || '没有输出'}</pre>
    </details> : verification.data === null && !verification.loading && !verification.error ? <p className="muted small">暂无验证记录。</p> : null}
  </div>
}

// ---------- 动作对话框 ----------

interface ActionDialogProps {
  open: boolean
  onClose: () => void
  data: IssueDetail
  onDone: () => void
  onConflict: (err: unknown) => boolean
}

function latestDelivery(data: IssueDetail): Delivery | undefined {
  return data.deliveries[data.deliveries.length - 1]
}

function CancelDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.cancel(data.issue.id, data.issue.version)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="取消工单"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            保留工单
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? '正在取消…' : '确认取消'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        将请求取消工单「{data.issue.title}」。正在执行的实例会收到取消信号；已经产生的执行记录与交付保留可查。
      </p>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function RetryDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.retry(data.issue.id, data.issue.version)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="重试工单"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            暂不重试
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? '正在重试…' : '确认重试'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        将把失败的工单「{data.issue.title}」重新放入执行队列。此前的执行记录、交付与评价保留可查，新的执行按当前配置开始。
      </p>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function AcceptDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [deliveryId, setDeliveryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (open) {
      setDeliveryId(latestDelivery(data)?.id ?? '')
      setError(null)
    }
  }, [open, data])

  async function confirm() {
    if (!deliveryId || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.accept(data.issue.id, deliveryId, data.issue.version)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="验收交付"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            再想想
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!deliveryId || busy}>
            {busy ? '正在验收…' : '确认验收'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>验收表示这份交付满足验收标准，工单随之完成。验收后仍可对工单评价。</p>
      <Field label="要验收的交付" htmlFor="accept-delivery">
        <select id="accept-delivery" className="select" value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
          {data.deliveries.map((delivery, index) => (
            <option key={delivery.id} value={delivery.id}>
              交付 {index + 1} · {formatDateTime(delivery.createdAt)}
            </option>
          ))}
        </select>
      </Field>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function ReworkDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [deliveryId, setDeliveryId] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (open) {
      setDeliveryId(latestDelivery(data)?.id ?? '')
      setInstructions('')
      setError(null)
    }
  }, [open, data])

  async function confirm() {
    if (!deliveryId || !instructions.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.rework(data.issue.id, deliveryId, instructions.trim(), data.issue.version)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="返工"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void confirm()}
            disabled={!deliveryId || !instructions.trim() || busy}
          >
            {busy ? '正在发回…' : '发回返工'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>返工会把工单退回执行队列并保留历史；同一张工单的多次执行只计一份有效评价。</p>
      <Field label="基于的交付" htmlFor="rework-delivery">
        <select id="rework-delivery" className="select" value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
          {data.deliveries.map((delivery, index) => (
            <option key={delivery.id} value={delivery.id}>
              交付 {index + 1} · {formatDateTime(delivery.createdAt)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="返工说明" htmlFor="rework-instructions" hint="写清需要修改什么，会随工单一起提供给下一次执行。">
        <textarea
          id="rework-instructions"
          className="textarea"
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function EvaluateDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [score, setScore] = useState(0)
  const [comment, setComment] = useState('')
  const [runId, setRunId] = useState('')
  const [deliveryId, setDeliveryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [idemKey, setIdemKey] = useState('')

  useEffect(() => {
    if (open) {
      setScore(data.evaluation?.active ? data.evaluation.score : 0)
      setComment(data.evaluation?.active ? data.evaluation.comment : '')
      setRunId(data.evaluation?.runId ?? data.runs[data.runs.length - 1]?.id ?? '')
      setDeliveryId(data.evaluation?.deliveryId ?? latestDelivery(data)?.id ?? '')
      setError(null)
      setIdemKey(newIdempotencyKey())
    }
  }, [open, data])

  async function confirm() {
    if (!runId || score < 1 || busy) return
    setBusy(true)
    setError(null)
    try {
      const input: { runId: string; deliveryId?: string; score: number; comment: string; expectedIssueVersion: number } = {
        runId,
        score,
        comment: comment.trim(),
        expectedIssueVersion: data.issue.version,
      }
      if (deliveryId) input.deliveryId = deliveryId
      await issuesApi.evaluate(data.issue.id, input, idemKey)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="评价工单"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!runId || score < 1 || busy}>
            {busy ? '正在保存…' : '保存评价'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>评分 1–5 分，属于这张工单；Profile 分数由工单评价聚合。修改评价会保留旧修订。</p>
      <Field label="分值" htmlFor="eval-score">
        <div className="score-picker" id="eval-score" role="radiogroup" aria-label="分值 1 到 5">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className="score-btn"
              role="radio"
              aria-checked={score === value}
              aria-pressed={score === value}
              onClick={() => setScore(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </Field>
      <Field label="意见" htmlFor="eval-comment">
        <textarea
          id="eval-comment"
          className="textarea"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="交付质量、沟通与需要改进的地方"
        />
      </Field>
      <Field label="归因执行" htmlFor="eval-run" hint="评分归因到这次执行使用的 Profile 配置修订。">
        <select id="eval-run" className="select" value={runId} onChange={(e) => setRunId(e.target.value)}>
          {data.runs.map((run) => (
            <option key={run.id} value={run.id}>
              第 {run.attempt} 次执行 · {runStatusMeta(run.status).label}
            </option>
          ))}
        </select>
      </Field>
      {data.deliveries.length > 0 ? (
        <Field label="关联交付（可选）" htmlFor="eval-delivery">
          <select id="eval-delivery" className="select" value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
            <option value="">不关联</option>
            {data.deliveries.map((delivery, index) => (
              <option key={delivery.id} value={delivery.id}>
                交付 {index + 1} · {formatDateTime(delivery.createdAt)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function IntegrateDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const [deliveryId, setDeliveryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [idemKey, setIdemKey] = useState('')

  useEffect(() => {
    if (open) {
      setDeliveryId(data.issue.acceptedDeliveryId ?? latestDelivery(data)?.id ?? '')
      setError(null)
      setIdemKey(newIdempotencyKey())
    }
  }, [open, data])

  async function confirm() {
    if (!deliveryId || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.integrate(data.issue.id, deliveryId, data.issue.version, idemKey)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="发起集成"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!deliveryId || busy}>
            {busy ? '正在创建…' : '创建集成候选'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        从交付创建一个集成候选。候选就绪后，仍需要你显式执行应用，服务不会自动改写本地工作区。
      </p>
      <Field label="交付" htmlFor="integrate-delivery">
        <select id="integrate-delivery" className="select" value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
          {data.deliveries.map((delivery, index) => (
            <option key={delivery.id} value={delivery.id}>
              交付 {index + 1} · {formatDateTime(delivery.createdAt)}
              {data.issue.acceptedDeliveryId === delivery.id ? '（已验收）' : ''}
            </option>
          ))}
        </select>
      </Field>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}
