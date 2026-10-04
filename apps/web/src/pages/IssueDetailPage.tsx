import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  applicationsApi,
  isConflict,
  issuesApi,
  newIdempotencyKey,
  profilesApi,
  runsApi,
  checkpointFileUrl,
} from '@/api/client'
import { useEventStream, useNow, useQuery } from '@/api/hooks'
import type { Application, Delivery, IssueDetail, Profile, Run, RunCheckpoint } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { DeliveryReview } from '@/components/DeliveryReview'
import { Dialog } from '@/components/Dialog'
import { EventLine } from '@/components/EventLine'
import { MarkdownView } from '@/components/MarkdownView'
import { PlanFields, lines } from '@/components/PlanFields'
import { QuestionCard } from '@/components/QuestionCard'
import { useToast } from '@/components/Toast'
import { Dot, EmptyState, ErrorBox, Field, IdTag, JsonDetails, LoadingBlock, StatusPill } from '@/components/ui'
import { describeStage, latestReadyApplication } from '@/lib/stage'
import { applicationStatusMeta, EVIDENCE_KIND, EVIDENCE_OUTCOME, FILE_CHANGE_KIND, issueStatusMeta, runStatusMeta } from '@/lib/status'
import { formatBytes, formatDateTime, formatDuration, timeAgo } from '@/lib/time'
import { useProjectTasks } from '@/lib/useProjectTasks'

function visibleAssistantReply(text: string): string {
  return text
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*$/gi, '')
    .trim()
}

const TERMINAL_ISSUE = new Set(['accepted', 'failed', 'cancelled', 'recovery_required'])
const ACTIVE_RUN = new Set(['starting', 'running', 'needs_input', 'cancelling'])
const TABS = [
  ['run', '持续执行'],
  ['review', '交付审查'],
  ['brief', '任务说明'],
  ['history', '历史'],
] as const
type TabId = (typeof TABS)[number][0]

function preferredTab(status: string, questions: number): TabId {
  if (questions > 0) return 'run'
  if (status === 'awaiting_review' || status === 'accepted') return 'review'
  return 'run'
}

function isTab(value: string | null): value is TabId {
  return value === 'run' || value === 'review' || value === 'brief' || value === 'history'
}

export function IssueDetailPage() {
  const { issueId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const detail = useQuery(() => issuesApi.detail(issueId), [issueId])
  const profiles = useQuery(() => profilesApi.list(), [])
  const [dialog, setDialog] = useState<'cancel' | 'retry' | 'accept' | 'rework' | 'evaluate' | 'integrate' | null>(null)
  const [applyTarget, setApplyTarget] = useState<Application | null>(null)
  const requestedTab = params.get('tab')
  const [stickyTab, setStickyTab] = useState<TabId | null>(null)
  useEffect(() => {
    setStickyTab(null)
    setDialog(null)
    setApplyTarget(null)
  }, [issueId])
  useEffect(() => {
    const loaded = detail.data
    if (!loaded || isTab(requestedTab) || loaded.issue.id !== issueId) return
    setStickyTab((current) => current ?? preferredTab(loaded.issue.status, loaded.questions.length))
  }, [requestedTab, detail.data, issueId])

  const profilesById = useMemo(() => {
    const map = new Map<string, Profile>()
    for (const profile of profiles.data?.items ?? []) map.set(profile.id, profile)
    return map
  }, [profiles.data])

  const issue = detail.data?.issue ?? null
  const related = useProjectTasks(issue?.projectId ?? '')
  const stream = useEventStream(issue?.projectId, issue !== null)
  const runIds = useMemo(() => new Set((detail.data?.runs ?? []).map((run) => run.id)), [detail.data])
  const issueEvents = useMemo(
    () => stream.events.filter((event) => event.issueId === issueId || (event.runId !== null && runIds.has(event.runId))),
    [stream.events, issueId, runIds],
  )
  const latestEventSequence = issueEvents.at(-1)?.sequence ?? null
  useEffect(() => {
    if (latestEventSequence === null) return
    const timer = setTimeout(() => detail.refetch(), 250)
    return () => clearTimeout(timer)
  }, [latestEventSequence, issueId, detail.refetch])

  const failureDiagnostic = useMemo(() => {
    if (!issue || issue.status !== 'failed') return null
    for (let index = issueEvents.length - 1; index >= 0; index -= 1) {
      const event = issueEvents[index]
      if (event?.type !== 'issue.failed') continue
      const data = event.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const diagnostic = (data as Record<string, unknown>).diagnostic
        if (typeof diagnostic === 'string' && diagnostic) return diagnostic
      }
      return null
    }
    return null
  }, [issue, issueEvents])

  function handleActionError(err: unknown): boolean {
    if (isConflict(err)) {
      toast.notifyError('任务状态已变化，已刷新最新数据。')
      detail.refetch()
      return true
    }
    return false
  }

  if (detail.loading) {
    return (
      <div className="workspace">
        <LoadingBlock label="正在加载任务…" />
      </div>
    )
  }
  if (!detail.data || !issue) {
    return (
      <div className="workspace">
        <div className="workspace-body">
          <ErrorBox error={detail.error ?? new Error('任务不存在')} onRetry={detail.refetch} />
        </div>
      </div>
    )
  }

  const data = detail.data
  const meta = issueStatusMeta(issue.status)
  const dispatchProfile = issue.dispatch.profileId ? profilesById.get(issue.dispatch.profileId) : undefined
  const stage = describeStage({
    status: issue.status,
    accessMode: issue.accessMode,
    applications: data.applications,
    acceptedDeliveryId: issue.acceptedDeliveryId,
    pendingQuestions: data.questions.length,
    failureDiagnostic,
  })
  const canCancel = !TERMINAL_ISSUE.has(issue.status)
  const canRetry = issue.status === 'failed'
  const canReview = issue.status === 'awaiting_review'
  const canEvaluate = data.runs.length > 0 && issue.status !== 'cancelled'
  const canIntegrate = data.deliveries.length > 0 && issue.status === 'accepted'
  const reportOnly = issue.accessMode === 'read-only'
  const readyToWrite = latestReadyApplication(data.applications, issue.acceptedDeliveryId)
  const tab: TabId = isTab(requestedTab) ? requestedTab : (stickyTab ?? preferredTab(issue.status, data.questions.length))
  const projectQuery = params.get('project')
  const backSearch = new URLSearchParams()
  if (projectQuery) backSearch.set('project', projectQuery)
  if (params.get('view') === 'list') backSearch.set('view', 'list')
  const backTo = `/issues${backSearch.toString() ? `?${backSearch.toString()}` : ''}`

  function selectTab(next: TabId) {
    setStickyTab(next)
    const query = new URLSearchParams(params)
    query.set('tab', next)
    setParams(query, { replace: true })
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const order = TABS.map(([id]) => id)
    const index = order.indexOf(tab)
    if (index < 0) return
    let nextIndex = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % order.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + order.length) % order.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = order.length - 1
    else return
    event.preventDefault()
    const next = order[nextIndex]
    if (!next || next === tab) return
    selectTab(next)
    document.getElementById(`task-tab-${next}`)?.focus()
  }

  return (
    <div className="workspace">
      {detail.error ? <ErrorBox error={detail.error} onRetry={detail.refetch} /> : null}
      <header className="workspace-head">
        <div style={{ minWidth: 0 }}>
          <div className="crumb">
            <Link to={backTo}>任务</Link>
            <StatusPill label={meta.label} color={meta.color} strong />
            <span>更新于 {timeAgo(issue.updatedAt)}</span>
          </div>
          <h1>{issue.title}</h1>
        </div>
        <div className="head-actions">
          {canRetry ? (
            <button type="button" className="btn btn-primary" onClick={() => setDialog('retry')}>
              重试
            </button>
          ) : null}
          {canReview ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setDialog('accept')}>
                验收
              </button>
              <button type="button" className="btn" onClick={() => setDialog('rework')}>
                返工
              </button>
            </>
          ) : null}
          {readyToWrite ? (
            <button type="button" className={reportOnly ? 'btn' : 'btn btn-primary'} onClick={() => setApplyTarget(readyToWrite)}>
              确认写入
            </button>
          ) : null}
          {canIntegrate ? (
            <button type="button" className={!readyToWrite && !reportOnly ? 'btn btn-primary' : 'btn'} onClick={() => setDialog('integrate')}>
              {reportOnly ? '准备候选（可选）' : '准备候选'}
            </button>
          ) : null}
          {canCancel ? (
            <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
              取消任务
            </button>
          ) : null}
        </div>
      </header>

      <section className={`stage ${stage.tone === 'neutral' ? '' : stage.tone}`} aria-label="当前阶段">
        <div className="stage-kicker">当前阶段 · {stage.stage}</div>
        <div className="stage-next">{stage.next}</div>
      </section>

      {data.questions.length > 0 ? (
        <section className="questions" aria-label="待回答的问题">
          <div className="notice-box">执行停在这里。回答下面的问题后，任务才会继续。</div>
          {data.questions.map((question) => (
            <QuestionCard key={question.id} question={question} onAnswered={() => detail.refetch()} />
          ))}
        </section>
      ) : null}

      <div className="tabs" role="tablist" aria-label="任务内容" aria-orientation="horizontal" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            id={`task-tab-${id}`}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === id}
            aria-controls="task-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => selectTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="workspace-body" role="tabpanel" id="task-panel" aria-labelledby={`task-tab-${tab}`}>
        {tab === 'run' ? (
          <>
            <RunsPanel runs={data.runs} currentRunId={issue.currentRunId} profilesById={profilesById} />
            <RunMessage key={issue.currentRunId ?? 'unclaimed'} run={data.runs.find((item) => item.id === issue.currentRunId) ?? null} />
            <CommentsPanel data={data} onChanged={() => detail.refetch()} onConflict={handleActionError} />
            <CheckpointsPanel data={data} onChanged={detail.refetch} onConflict={handleActionError} />
          </>
        ) : null}
        {tab === 'review' ? (
          <>
            <DeliveriesPanel deliveries={data.deliveries} issue={data.issue} onAccept={() => setDialog('accept')} onRework={() => setDialog('rework')} />
            {issue.status === 'accepted' || data.applications.length > 0 ? (
              <ApplicationsPanel applications={data.applications} acceptedDeliveryId={issue.acceptedDeliveryId} onApply={setApplyTarget} />
            ) : data.deliveries.length > 0 ? (
              <p className="muted">验收之后，才可以准备写入项目的候选。准备和写入都要你单独确认。</p>
            ) : null}
          </>
        ) : null}
        {tab === 'brief' ? (
          <>
            <TaskPanel data={data} dispatchProfile={dispatchProfile} taskTitles={related.tasks} />
            <PlanEditor
              key={issue.id}
              data={data}
              tasks={related.tasks}
              tasksLoading={related.loading}
              tasksFailed={related.failed}
              onChanged={detail.refetch}
              onConflict={handleActionError}
            />
          </>
        ) : null}
        {tab === 'history' ? (
          <>
            <EventsPanel events={issueEvents} connected={stream.connected} failed={stream.error} onReconnect={stream.reset} />
            <EvaluationPanel data={data} onEvaluate={() => setDialog('evaluate')} canEvaluate={canEvaluate} profilesById={profilesById} />
          </>
        ) : null}
      </div>

      <CancelDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('已请求取消'); detail.refetch() }} onConflict={handleActionError} />
      <RetryDialog open={dialog === 'retry'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('任务已重新排队'); detail.refetch() }} onConflict={handleActionError} />
      <AcceptDialog open={dialog === 'accept'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('交付已验收'); detail.refetch() }} onConflict={handleActionError} />
      <ReworkDialog open={dialog === 'rework'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('已发回返工'); detail.refetch() }} onConflict={handleActionError} />
      <EvaluateDialog open={dialog === 'evaluate'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('评价已保存'); detail.refetch() }} onConflict={handleActionError} />
      <IntegrateDialog open={dialog === 'integrate'} onClose={() => setDialog(null)} data={data} onDone={() => { setDialog(null); toast.notify('已创建候选'); detail.refetch() }} onConflict={handleActionError} />
      <ApplyDialog application={applyTarget} onClose={() => setApplyTarget(null)} onDone={() => { setApplyTarget(null); toast.notify('已请求写入项目'); detail.refetch() }} />
    </div>
  )
}

function TaskPanel({
  data,
  dispatchProfile,
  taskTitles,
}: {
  data: IssueDetail
  dispatchProfile: Profile | undefined
  taskTitles: { id: string; title: string }[]
}) {
  const { issue } = data
  const titleById = new Map(taskTitles.map((task) => [task.id, task.title]))
  return (
    <section className="panel" aria-label="任务说明">
      <h2 className="section-title">要做什么</h2>
      <p className="prose">{issue.description}</p>
      {issue.acceptanceCriteria.length > 0 ? (
        <>
          <h3 className="field-label" style={{ marginBottom: 6 }}>怎样算做完</h3>
          <ul className="list-plain checklist">
            {issue.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">没有单独列出的验收标准。</p>
      )}
      <hr className="divider" />
      <dl className="kv">
        <dt>谁来执行</dt>
        <dd>
          {issue.dispatch.mode === 'require' ? (
            dispatchProfile ? (
              <span className="task-owner">
                <Avatar presetId={dispatchProfile.avatarPresetId} size={18} label={dispatchProfile.name} />
                指定 {dispatchProfile.name}
              </span>
            ) : (
              <span>指定了一份执行配置，但当前列表里找不到它。</span>
            )
          ) : (
            '自动分配'
          )}
        </dd>
        <dt>依赖任务</dt>
        <dd>
          {issue.dependsOn.length === 0 ? '无' : issue.dependsOn.map((id) => (
            <Link key={id} to={`/issues/${encodeURIComponent(id)}`} style={{ marginRight: 8 }}>
              {titleById.get(id) ?? '未加载到标题的任务'}
            </Link>
          ))}
        </dd>
        <dt>可修改路径</dt>
        <dd>{issue.accessMode === 'read-only' ? '不可修改项目文件' : issue.ownedPaths?.length ? issue.ownedPaths.join('，') : '不限'}</dd>
        <dt>只读路径</dt>
        <dd>{issue.readOnlyPaths?.length ? issue.readOnlyPaths.join('，') : '无'}</dd>
        <dt>访问</dt>
        <dd>{issue.accessMode === 'read-only' ? '只读，只产生报告' : '可以修改项目'}</dd>
        <dt>值守</dt>
        <dd>{issue.attendance === 'bounded-unattended' ? '有界无人值守' : '人工值守'}</dd>
        <dt>隔离</dt>
        <dd>{issue.isolationRequirement === 'full' ? '完整隔离' : '受信主机'}</dd>
      </dl>
      <details className="fold">
        <summary>编号与来源</summary>
        <dl className="kv">
          <dt>任务编号</dt>
          <dd><IdTag value={issue.id} /></dd>
          <dt>版本</dt>
          <dd>v{issue.version}</dd>
          <dt>来源</dt>
          <dd>{issue.requesterRef}</dd>
          {issue.clientRequestId ? (
            <>
              <dt>创建请求号</dt>
              <dd className="mono">{issue.clientRequestId}</dd>
            </>
          ) : null}
          <dt>创建时间</dt>
          <dd>{formatDateTime(issue.createdAt)}</dd>
          {issue.dispatch.profileId ? (
            <>
              <dt>执行配置编号</dt>
              <dd><IdTag value={issue.dispatch.profileId} /></dd>
            </>
          ) : null}
          {issue.dependsOn.length > 0 ? (
            <>
              <dt>依赖编号</dt>
              <dd className="mono">{issue.dependsOn.join('，')}</dd>
            </>
          ) : null}
        </dl>
      </details>
    </section>
  )
}

function PlanEditor({
  data,
  tasks,
  tasksLoading,
  tasksFailed,
  onChanged,
  onConflict,
}: {
  data: IssueDetail
  tasks: { id: string; title: string }[]
  tasksLoading: boolean
  tasksFailed: boolean
  onChanged: () => void
  onConflict: (error: unknown) => boolean
}) {
  const { issue } = data
  const canEdit = (issue.status === 'queued' || issue.status === 'blocked') && data.runs.length === 0
  const [editing, setEditing] = useState(false)
  const [draftVersion, setDraftVersion] = useState(issue.version)
  const [dependsOn, setDependsOn] = useState('')
  const [ownedPaths, setOwnedPaths] = useState('')
  const [readOnlyPaths, setReadOnlyPaths] = useState('')
  const [accessMode, setAccessMode] = useState<'read-only' | 'workspace-write'>('workspace-write')
  const [attendance, setAttendance] = useState<'manual' | 'bounded-unattended'>('manual')
  const [isolationRequirement, setIsolationRequirement] = useState<'trusted-host' | 'full'>('trusted-host')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  function start() {
    setDraftVersion(issue.version)
    setDependsOn(issue.dependsOn.join('\n'))
    setOwnedPaths((issue.ownedPaths ?? []).join('\n'))
    setReadOnlyPaths((issue.readOnlyPaths ?? []).join('\n'))
    setAccessMode(issue.accessMode ?? 'workspace-write')
    setAttendance(issue.attendance ?? 'manual')
    setIsolationRequirement(issue.isolationRequirement ?? 'trusted-host')
    setError(null)
    setEditing(true)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.updatePlan(issue.id, {
        expectedIssueVersion: draftVersion,
        dependsOn: lines(dependsOn),
        ownedPaths: lines(ownedPaths),
        readOnlyPaths: lines(readOnlyPaths),
        accessMode,
        attendance,
        isolationRequirement,
      })
      setEditing(false)
      onChanged()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit && !editing) return null
  const advancedInitiallyOpen = (issue.ownedPaths?.length ?? 0) > 0 || (issue.readOnlyPaths?.length ?? 0) > 0 || issue.accessMode === 'read-only' || issue.attendance === 'bounded-unattended' || issue.isolationRequirement === 'full'
  return (
    <section className="panel" aria-label="执行前可改的安排">
      <h2 className="section-title">执行前可改的安排</h2>
      <p className="muted small">第一次执行开始之前，可以改依赖、路径、只读范围、值守和隔离。开始之后这些内容就冻结了。</p>
      {!editing ? (
        <button type="button" className="btn btn-sm" onClick={start}>修改依赖和范围</button>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <PlanFields
            prefix="issue-plan"
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
            projectTasks={tasks}
            tasksLoading={tasksLoading}
            tasksFailed={tasksFailed}
            excludeTaskId={issue.id}
            advancedInitiallyOpen={advancedInitiallyOpen}
          />
          {error ? <ErrorBox error={error} /> : null}
          {!canEdit ? <div className="notice-box">任务已经开始或状态变了，不能再改。请刷新。</div> : null}
          <div className="actions-row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !canEdit}>{busy ? '正在保存…' : '保存'}</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>取消</button>
          </div>
        </form>
      )}
    </section>
  )
}

function CheckpointsPanel({ data, onChanged, onConflict }: { data: IssueDetail; onChanged: () => void; onConflict: (error: unknown) => boolean }) {
  const { issue, runs } = data
  const checkpoints = useQuery(() => issuesApi.checkpoints(issue.id), [issue.id])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const checkpointedRuns = new Set((checkpoints.data ?? []).map((checkpoint) => checkpoint.runId))
  const terminalRuns = runs.filter((run) => ['failed', 'cancelled', 'interrupted'].includes(run.status) && !checkpointedRuns.has(run.id))
  const canResume = issue.status === 'failed' || issue.status === 'cancelled'
  if (runs.length === 0) return null

  async function create(runId: string) {
    if (busy) return
    setBusy(runId)
    setError(null)
    try {
      await runsApi.checkpoint(runId)
      checkpoints.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  async function resume(checkpoint: RunCheckpoint) {
    if (busy) return
    setBusy(checkpoint.id)
    setError(null)
    try {
      await issuesApi.resume(issue.id, checkpoint.id, issue.version)
      onChanged()
      checkpoints.refetch()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(null)
    }
  }

  const saved = checkpoints.data ?? []
  if (!checkpoints.loading && saved.length === 0 && terminalRuns.length === 0) {
    return <p className="muted">还没有检查点。检查点只保存未完成的文件，不能当作交付来验收或写入。</p>
  }

  return (
    <section className="panel" aria-label="检查点">
      <h2 className="section-title">检查点 <span className="count">{saved.length}</span></h2>
      <p className="muted small">检查点保存还没完成的文件。继续执行要你明确选择。它不能被验收，也不能写入项目。</p>
      {checkpoints.error ? <ErrorBox error={checkpoints.error} onRetry={checkpoints.refetch} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {terminalRuns.length > 0 ? (
        <div className="actions-row">
          {terminalRuns.map((run) => (
            <button key={run.id} type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void create(run.id)}>
              保存第 {run.attempt} 次执行的检查点
            </button>
          ))}
        </div>
      ) : null}
      {checkpoints.loading && !checkpoints.data ? <LoadingBlock label="正在加载检查点…" /> : null}
      {saved.length > 0 ? (
        <ul className="list-plain">
          {[...saved].reverse().map((checkpoint) => (
            <li key={checkpoint.id}>
              <div className="dispatch-project">
                <strong>{formatDateTime(checkpoint.createdAt)}</strong>
                <span className="muted small">{checkpoint.files.length} 个文件</span>
              </div>
              <p className="muted small" style={{ margin: '4px 0' }}>{checkpoint.reason}</p>
              {checkpoint.files.map((file) => (
                <div className="file-row" key={file.path}>
                  <span className={`file-kind file-kind-${file.kind}`}>{FILE_CHANGE_KIND[file.kind]}</span>
                  <a className="mono" href={checkpointFileUrl(checkpoint.id, file.path)} download>{file.path}</a>
                </div>
              ))}
              {canResume ? (
                <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void resume(checkpoint)}>
                  从这里继续
                </button>
              ) : null}
              <details className="fold">
                <summary>检查点编号</summary>
                <IdTag value={checkpoint.id} />
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

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

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setLastReport(null)
    try {
      const result = await issuesApi.comment(data.issue.id, text.trim())
      setText('')
      setLastReport(result.report.delivered ? '已保存，并送到了正在执行的实例。' : '已保存。实例现在不在接收，它之后能读到。')
      onChanged()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-label="补充说明">
      <h2 className="section-title">补充说明 <span className="count">{data.comments.length}</span></h2>
      {data.comments.length > 0 ? (
        <ul className="list-plain" style={{ marginBottom: 12 }}>
          {data.comments.map((comment) => (
            <li key={comment.id}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{comment.text}</div>
              <div className="muted small">
                {comment.author ?? '操作员'} · {formatDateTime(comment.createdAt)}
                {comment.delivered === false ? ' · 还没送到实例' : ''}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">还没有补充。执行过程中可以在这里追加要求，内容会先保存下来。</p>
      )}
      <form onSubmit={submit}>
        <div className="field" style={{ marginBottom: 8 }}>
          <label className="field-label" htmlFor="comment-text">追加补充</label>
          <textarea id="comment-text" className="textarea" rows={2} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {lastReport ? <div className="ok-box" role="status">{lastReport}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="submit" className="btn" disabled={!text.trim() || busy}>{busy ? '正在提交…' : '提交补充'}</button>
        </div>
      </form>
    </section>
  )
}

function RunMessage({ run }: { run: Run | null }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [report, setReport] = useState<string | null>(null)
  if (!run) return <p className="muted">还没有执行。开始之后，可以在这里给正在运行的实例发消息。</p>
  const active = ACTIVE_RUN.has(run.status)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!run || !text.trim() || busy) return
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const result = await runsApi.sendMessage(run.id, text.trim())
      setText('')
      setReport(result.delivered ? '消息已保存，并送到了实例。' : '消息已保存。实例现在不在接收，它之后能读到。')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel" aria-label="给执行发消息">
      <h2 className="section-title">
        给这次执行发消息
        <Link to={`/runs/${encodeURIComponent(run.id)}`}>打开执行记录</Link>
      </h2>
      {active ? (
        <form onSubmit={submit}>
          <textarea className="textarea" rows={3} aria-label="消息内容" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} placeholder="补充指令或上下文" />
          {error ? <ErrorBox error={error} /> : null}
          {report ? <div className="ok-box" role="status">{report}</div> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy}>{busy ? '正在发送…' : '发送'}</button>
          </div>
        </form>
      ) : (
        <p className="muted small">这次执行已经结束，不能再发消息。记录还在执行页里。</p>
      )}
    </section>
  )
}

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
    <section className="panel" aria-label="发生过的事">
      <h2 className="section-title">
        发生过的事 <span className="count">{events.length}</span>
        <span className={`pill${connected ? ' pill-strong' : ''}`} role="status">
          <Dot color={connected ? 'var(--st-ok)' : 'var(--st-off)'} />
          {connected ? '正在接收新事件' : '没有连上实时事件'}
        </span>
      </h2>
      {failed && !connected ? (
        <div className="notice-box" style={{ marginBottom: 8 }}>
          实时连接中断了，正在重试。
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReconnect}>现在重连</button>
        </div>
      ) : null}
      {events.length === 0 ? (
        <p className="muted small">还没有事件。任务被领取、执行和交付时，会记在这里。没有事件就不表示有进度。</p>
      ) : (
        <div className="events">
          {[...events].reverse().map((event) => (
            <EventLine key={event.sequence} event={event} />
          ))}
        </div>
      )}
    </section>
  )
}

function RunsPanel({
  runs,
  currentRunId,
  profilesById,
}: {
  runs: Run[]
  currentRunId: string | null
  profilesById: Map<string, Profile>
}) {
  const anyActive = runs.some((run) => ACTIVE_RUN.has(run.status))
  const now = useNow(anyActive)
  return (
    <section className="panel" aria-label="执行">
      <h2 className="section-title">执行 <span className="count">{runs.length}</span></h2>
      {runs.length === 0 ? (
        <p className="muted small">还没有人领取这张任务。</p>
      ) : (
        <ul className="list-plain">
          {[...runs].reverse().map((run) => {
            const meta = runStatusMeta(run.status)
            const profile = profilesById.get(run.profileId)
            const duration = formatDuration(run.startedAt, run.endedAt, now)
            return (
              <li key={run.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Dot color={meta.color} />
                  <Link to={`/runs/${encodeURIComponent(run.id)}`}>第 {run.attempt} 次执行</Link>
                  {run.id === currentRunId ? <span className="pill pill-strong">当前</span> : null}
                  <span className="muted small" style={{ marginLeft: 'auto' }}>
                    {meta.label}
                    {duration ? ` · ${duration}` : ''}
                  </span>
                </div>
                <div className="row-meta">
                  {profile ? (
                    <span className="task-owner">
                      <Avatar presetId={profile.avatarPresetId} size={16} label={profile.name} />
                      <span>{profile.name}</span>
                    </span>
                  ) : (
                    <span>执行配置未在列表中</span>
                  )}
                  <span>{run.modelId}{run.reasoningEffort ? ` · 思考强度 ${run.reasoningEffort}` : ''}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

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
  if (deliveries.length === 0) {
    return <p className="muted">执行结束后，冻结的交付会出现在这里，等你验收。现在还没有。</p>
  }
  return (
    <section aria-label="交付">
      <h2 className="section-title">冻结交付 <span className="count">{deliveries.length}</span></h2>
      {[...deliveries].reverse().map((delivery, reverseIndex) => {
        const summary = visibleAssistantReply(delivery.summary)
        const reply = visibleAssistantReply(delivery.finalResponse ?? '')
        const report = summary || reply || '交付已生成。下面是文件和记录下来的证据。'
        return (
          <article key={delivery.id} className="panel" style={{ marginTop: reverseIndex === 0 ? 0 : 12 }}>
            <div className="dispatch-project">
              <strong>{formatDateTime(delivery.createdAt)}</strong>
              <span>{issue.acceptedDeliveryId === delivery.id ? <span className="pill pill-strong">已验收的那一份</span> : null}</span>
            </div>
            <MarkdownView text={report} />
            {reply && reply !== summary ? (
              <details className="fold">
                <summary>执行结束时的回复</summary>
                <MarkdownView text={reply} />
              </details>
            ) : null}
            <h3 className="field-label" style={{ margin: '12px 0 6px' }}>文件</h3>
            <DeliveryReview delivery={delivery} />
            <h3 className="field-label" style={{ margin: '12px 0 6px' }}>记录下来的证据</h3>
            <p className="evidence-note">验证证据来自实际跑过的检查。模型自述和生命周期记录只说明当时说了什么或发生了什么，不能当成验证通过。</p>
            {delivery.evidence.length === 0 ? <p className="muted small">这份交付没有附带证据记录。</p> : (
              <ul className="list-plain">
                {delivery.evidence.map((evidence, index) => {
                  const outcome = EVIDENCE_OUTCOME[evidence.outcome]
                  return (
                    <li key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <Dot color={outcome.color} />
                      <span>
                        {evidence.label}
                        <span className="muted">（{EVIDENCE_KIND[evidence.kind]} · {outcome.label}）</span>
                        {evidence.detail ? <span className="muted small"> {evidence.detail}</span> : null}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <details className="fold">
              <summary>交付编号和清单摘要</summary>
              <dl className="kv">
                <dt>交付编号</dt>
                <dd><IdTag value={delivery.id} /></dd>
                <dt>清单摘要</dt>
                <dd className="mono">{delivery.manifestSha256}</dd>
              </dl>
              {delivery.finalResponse ? <JsonDetails data={reply || delivery.finalResponse} summary="原始回复文本" /> : null}
            </details>
            {canReview ? (
              <div className="actions-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={onAccept}>验收</button>
                <button type="button" className="btn btn-sm" onClick={onRework}>返工</button>
              </div>
            ) : null}
          </article>
        )
      })}
    </section>
  )
}

function EvaluationPanel({
  data,
  canEvaluate,
  onEvaluate,
  profilesById,
}: {
  data: IssueDetail
  canEvaluate: boolean
  onEvaluate: () => void
  profilesById: Map<string, Profile>
}) {
  const evaluation = data.evaluation
  const profile = evaluation ? profilesById.get(evaluation.profileId) : undefined
  return (
    <section className="panel" aria-label="评价">
      <h2 className="section-title">评价</h2>
      {evaluation && evaluation.active ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 22 }}>{evaluation.score}</strong>
            <span className="muted">/ 5</span>
          </div>
          {evaluation.comment ? <p className="prose">{evaluation.comment}</p> : null}
          <p className="muted small">
            记在{profile ? `「${profile.name}」` : '对应执行配置'}的这一版配置上。评价时间 {formatDateTime(evaluation.createdAt)}。
          </p>
        </div>
      ) : (
        <p className="muted small">还没有评价。分数属于这张任务，并记到当时使用的执行配置上。没打分不会当成 0 分。</p>
      )}
      {canEvaluate ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn" onClick={onEvaluate}>{evaluation && evaluation.active ? '修改评价' : '写评价'}</button>
        </div>
      ) : null}
    </section>
  )
}

function ApplicationsPanel({
  applications,
  acceptedDeliveryId,
  onApply,
}: {
  applications: Application[]
  acceptedDeliveryId: string | null
  onApply: (application: Application) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const writable = latestReadyApplication(applications, acceptedDeliveryId)
  const hasObsolete = applications.some((item) => item.deliveryId !== acceptedDeliveryId)
  return (
    <section className="panel" aria-label="写入项目">
      <h2 className="section-title">写入项目 <span className="count">{applications.length}</span></h2>
      <p className="muted small">
        只有当前验收的交付可以准备和写入。
        {hasObsolete ? '更早的候选留在这里作记录，不能再确认写入。' : '候选准备好之后，仍要你确认才会改本地项目。'}
      </p>
      {applications.length === 0 ? <p className="muted small">还没有候选。</p> : (
        <ul className="list-plain">
          {[...applications].reverse().map((application) => {
            const meta = applicationStatusMeta(application.status)
            const current = acceptedDeliveryId !== null && application.deliveryId === acceptedDeliveryId
            const troubled = ['failed', 'recovery_required', 'conflict'].includes(application.status)
            return (
              <li key={application.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <StatusPill label={meta.label} color={meta.color} />
                  {current ? null : <span className="pill">更早的交付，不能再写入</span>}
                  <span className="actions-row" style={{ marginLeft: 'auto' }}>
                    <button type="button" className="btn btn-ghost btn-sm" aria-expanded={expanded === application.id} onClick={() => setExpanded((currentId) => (currentId === application.id ? null : application.id))}>
                      {expanded === application.id ? '收起' : '诊断'}
                    </button>
                    {writable?.id === application.id ? (
                      <button type="button" className="btn btn-sm" onClick={() => onApply(application)}>确认写入</button>
                    ) : null}
                  </span>
                </div>
                <dl className="kv" style={{ marginTop: 6 }}>
                  <dt>目标</dt>
                  <dd className="mono">{application.expectedTarget ?? '由服务根据项目决定'}</dd>
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
                      <div className="small" style={{ marginTop: 4 }}>目标项目可能停在中间状态。重启服务不会自动解除。</div>
                    ) : null}
                  </div>
                ) : null}
                {current && troubled && application.status !== 'recovery_required' ? <p className="muted small">看完诊断后，可以再准备一个新的候选。</p> : null}
                {expanded === application.id ? <ApplicationDiagnostics key={application.id} applicationId={application.id} /> : null}
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
  return (
    <div style={{ marginTop: 8 }}>
      {detail.error ? <ErrorBox error={detail.error} onRetry={detail.refetch} /> : null}
      {detail.loading && !detail.data ? <LoadingBlock label="正在加载候选…" /> : null}
      {detail.data ? (
        detail.data.evidence.length > 0 ? (
          <ul className="list-plain">
            {detail.data.evidence.map((evidence, index) => {
              const outcome = EVIDENCE_OUTCOME[evidence.outcome]
              return (
                <li key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <Dot color={outcome.color} />
                  <span>{evidence.label}<span className="muted">（{EVIDENCE_KIND[evidence.kind]} · {outcome.label}）</span></span>
                </li>
              )
            })}
          </ul>
        ) : <p className="muted small">这个候选没有另外的证据记录。</p>
      ) : null}
      {verification.error ? <ErrorBox error={verification.error} onRetry={verification.refetch} /> : null}
      {verification.data ? (
        <details className="fold" open>
          <summary>验证命令{verification.data.exitCode === 0 ? '通过' : '没有通过'}</summary>
          <dl className="kv">
            <dt>命令</dt>
            <dd className="mono">{verification.data.command.join(' ')}</dd>
            <dt>结束</dt>
            <dd>{verification.data.exitCode === null ? '没有退出码' : `退出码 ${verification.data.exitCode}`}{verification.data.signal ? ` · 信号 ${verification.data.signal}` : ''}</dd>
            <dt>时间</dt>
            <dd>{formatDateTime(verification.data.startedAt)} — {formatDateTime(verification.data.finishedAt)}</dd>
          </dl>
          <p className="small">{verification.data.summary}</p>
          {verification.data.truncated ? <p className="notice-box small">日志被截断了，省略了 {formatBytes(verification.data.omittedBytes)}。下面保留开头和结尾。</p> : null}
          <pre className="verification-output">{verification.data.output || '没有输出'}</pre>
        </details>
      ) : verification.data === null && !verification.loading && !verification.error ? (
        <p className="muted small">还没有验证命令的记录。</p>
      ) : null}
    </div>
  )
}

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
    <Dialog open={open} onClose={onClose} title="取消任务" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>保留任务</button><button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>{busy ? '正在取消…' : '确认取消'}</button></>}>
      <p style={{ marginTop: 0 }}>将请求取消「{data.issue.title}」。正在执行的实例会收到取消信号。已经产生的记录和交付还在。</p>
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
    <Dialog open={open} onClose={onClose} title="重试任务" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>先不重试</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>{busy ? '正在重试…' : '确认重试'}</button></>}>
      <p style={{ marginTop: 0 }}>把失败的「{data.issue.title}」重新放回队列。以前的执行、交付和评价都保留。</p>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function useActionVersion(open: boolean, data: IssueDetail) {
  const version = useRef(data.issue.version)
  useEffect(() => {
    if (open) version.current = data.issue.version
  }, [open, data.issue.id])
  return version
}

function AcceptDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const version = useActionVersion(open, data)
  const [deliveryId, setDeliveryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (open) {
      setDeliveryId(latestDelivery(data)?.id ?? '')
      setError(null)
    }
  }, [open, data.issue.id])
  async function confirm() {
    if (!deliveryId || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.accept(data.issue.id, deliveryId, version.current)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="验收交付" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>再看看</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!deliveryId || busy}>{busy ? '正在验收…' : '确认验收'}</button></>}>
      <p style={{ marginTop: 0 }}>验收只确认这份冻结交付符合要求。它不会把文件写入项目。写入需要之后再准备候选，并单独确认。只读报告可以在验收后结束。</p>
      <Field label="要验收的交付" htmlFor="accept-delivery">
        <select id="accept-delivery" className="select" value={deliveryId} onChange={(event) => setDeliveryId(event.target.value)}>
          {data.deliveries.map((delivery, index) => (
            <option key={delivery.id} value={delivery.id}>第 {index + 1} 份 · {formatDateTime(delivery.createdAt)}</option>
          ))}
        </select>
      </Field>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function ReworkDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const version = useActionVersion(open, data)
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
  }, [open, data.issue.id])
  async function confirm() {
    if (!deliveryId || !instructions.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.rework(data.issue.id, deliveryId, instructions.trim(), version.current)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="发回返工" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!deliveryId || !instructions.trim() || busy}>{busy ? '正在发回…' : '发回返工'}</button></>}>
      <p style={{ marginTop: 0 }}>返工把任务退回队列，历史执行和交付都保留。</p>
      <Field label="基于哪一份交付" htmlFor="rework-delivery">
        <select id="rework-delivery" className="select" value={deliveryId} onChange={(event) => setDeliveryId(event.target.value)}>
          {data.deliveries.map((delivery, index) => (
            <option key={delivery.id} value={delivery.id}>第 {index + 1} 份 · {formatDateTime(delivery.createdAt)}</option>
          ))}
        </select>
      </Field>
      <Field label="要改什么" htmlFor="rework-instructions" hint="这些说明会交给下一次执行。">
        <textarea id="rework-instructions" className="textarea" rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </Field>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function EvaluateDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const version = useActionVersion(open, data)
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
  }, [open, data.issue.id])
  async function confirm() {
    if (!runId || score < 1 || busy) return
    setBusy(true)
    setError(null)
    try {
      const input: { runId: string; deliveryId?: string; score: number; comment: string; expectedIssueVersion: number } = {
        runId,
        score,
        comment: comment.trim(),
        expectedIssueVersion: version.current,
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
    <Dialog open={open} onClose={onClose} title="评价任务" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!runId || score < 1 || busy}>{busy ? '正在保存…' : '保存评价'}</button></>}>
      <p style={{ marginTop: 0 }}>1 到 5 分，属于这张任务。执行配置的分数由这些评价汇总。修改会保留旧记录。</p>
      <Field label="分值" htmlFor="eval-score">
        <div className="score-picker" id="eval-score" role="radiogroup" aria-label="分值 1 到 5">
          {[1, 2, 3, 4, 5].map((value) => (
            <button key={value} type="button" className="score-btn" role="radio" aria-checked={score === value} aria-pressed={score === value} onClick={() => setScore(value)}>{value}</button>
          ))}
        </div>
      </Field>
      <Field label="意见" htmlFor="eval-comment">
        <textarea id="eval-comment" className="textarea" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="交付质量、沟通，以及要改进的地方" />
      </Field>
      <Field label="记到哪一次执行" htmlFor="eval-run" hint="分数记到这次执行使用的那一版配置上。">
        <select id="eval-run" className="select" value={runId} onChange={(event) => setRunId(event.target.value)}>
          {data.runs.map((run) => (
            <option key={run.id} value={run.id}>第 {run.attempt} 次 · {runStatusMeta(run.status).label}</option>
          ))}
        </select>
      </Field>
      {data.deliveries.length > 0 ? (
        <Field label="关联交付（可选）" htmlFor="eval-delivery">
          <select id="eval-delivery" className="select" value={deliveryId} onChange={(event) => setDeliveryId(event.target.value)}>
            <option value="">不关联</option>
            {data.deliveries.map((delivery, index) => (
              <option key={delivery.id} value={delivery.id}>第 {index + 1} 份 · {formatDateTime(delivery.createdAt)}</option>
            ))}
          </select>
        </Field>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function IntegrateDialog({ open, onClose, data, onDone, onConflict }: ActionDialogProps) {
  const version = useActionVersion(open, data)
  const [deliveryId, setDeliveryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [idemKey, setIdemKey] = useState('')
  useEffect(() => {
    if (open) {
      setDeliveryId(data.issue.acceptedDeliveryId ?? '')
      setError(null)
      setIdemKey(newIdempotencyKey())
    }
  }, [open, data.issue.id])
  async function confirm() {
    if (!deliveryId || busy) return
    setBusy(true)
    setError(null)
    try {
      await issuesApi.integrate(data.issue.id, deliveryId, version.current, idemKey)
      onDone()
    } catch (err) {
      if (!onConflict(err)) setError(err)
    } finally {
      setBusy(false)
    }
  }
  const accepted = data.deliveries.find((item) => item.id === data.issue.acceptedDeliveryId)
  return (
    <Dialog open={open} onClose={onClose} title="准备写入候选" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!deliveryId || busy}>{busy ? '正在准备…' : '创建候选'}</button></>}>
      <p style={{ marginTop: 0 }}>这一步只准备候选，不会改本地项目。候选就绪后，还要你再确认一次才会写入。只读报告可以不进行这一步。更早的交付不能再准备写入。</p>
      {accepted ? (
        <p>使用当前验收的交付，时间 {formatDateTime(accepted.createdAt)}。</p>
      ) : (
        <p>当前没有已验收的交付，不能准备候选。</p>
      )}
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}

function ApplyDialog({
  application,
  onClose,
  onDone,
}: {
  application: Application | null
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (application) setError(null)
  }, [application])
  async function confirm() {
    if (!application || busy) return
    setBusy(true)
    setError(null)
    try {
      await applicationsApi.apply(application.id, application.expectedTarget, newIdempotencyKey())
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={application !== null} onClose={onClose} title="确认写入项目" busy={busy} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>先不写入</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>{busy ? '正在写入…' : '确认写入'}</button></>}>
      <p style={{ marginTop: 0 }}>这一步会把已就绪的候选写进本地项目。目标：{application?.expectedTarget ?? '由服务根据项目决定'}。</p>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  )
}
