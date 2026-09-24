/**
 * 统一 typed HTTP client。
 * - 所有响应为 { data } / { error }（docs/api-contract.md）。
 * - 浏览器同源 Cookie 会话 + CSRF 头；写操作带 Idempotency-Key（按契约要求的操作）。
 * - 列表响应兼容数组与 { items, nextCursor } 两种形状（契约两处表述不一致，见交付报告）。
 */
import type { Page } from './types'
import { getCsrfToken, notifySessionExpired, setCsrfToken } from './session'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** 版本冲突（陈旧 expectedIssueVersion / expectedRevision）。 */
export function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409
}

export function isAuthError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

const API_PREFIX = '/api/v1'
const CSRF_HEADER = 'x-csrf-token'

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | null | undefined>
  idempotencyKey?: string
  /** 内部使用：会话失效递归保护。 */
  _retried?: boolean
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams()
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return `${API_PREFIX}${path}${qs ? `?${qs}` : ''}`
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, idempotencyKey } = options
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') {
    const csrf = getCsrfToken()
    if (csrf) headers[CSRF_HEADER] = csrf
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey

  let response: Response
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接 Lachesis 服务。请确认服务已启动后重试。')
  }

  let payload: unknown = null
  const text = await response.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ApiError(response.status, 'bad_response', `服务返回了无法解析的响应（HTTP ${response.status}）。`)
    }
  }

  if (!response.ok) {
    const err = payload as { error?: { code?: string; message?: string; details?: unknown } } | null
    const code = err?.error?.code ?? `http_${response.status}`
    const message = err?.error?.message ?? `请求失败（HTTP ${response.status}）。`
    const details = err?.error?.details
    if ((response.status === 401 || response.status === 403) && !options._retried) {
      notifySessionExpired()
    }
    throw new ApiError(response.status, code, message, details)
  }

  const ok = payload as { data?: unknown } | null
  if (ok && typeof ok === 'object' && 'data' in ok) return ok.data as T
  // 健康检查等端点若未包 data，则原样返回，避免误报。
  return payload as T
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** 归一化分页：契约同时出现 T[] 与 { items, nextCursor } 两种表述。 */
export function asPage<T>(value: unknown): Page<T> {
  if (Array.isArray(value)) return { items: value as T[], nextCursor: null }
  const page = value as Partial<Page<T>> | null
  return {
    items: Array.isArray(page?.items) ? (page.items as T[]) : [],
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// ---- 各端点（全部对应 docs/api-contract.md 的 /api/v1 路径） ----

import type {
  Application,
  ApplicationDetail,
  CreateIssueInput,
  CreateProfileInput,
  CreateProjectInput,
  CreatedToken,
  Delivery,
  DeliveryReport,
  Evaluation,
  Evidence,
  HealthInfo,
  Id,
  Issue,
  IssueComment,
  IssueDetail,
  IssueEvent,
  McpTokenInfo,
  PairResult,
  PendingQuestion,
  PendingQuestionItem,
  Profile,
  ProfileHistoryEntry,
  Project,
  Run,
  RunDetail,
  SchedulerSettings,
  SchedulerSnapshot,
  ProjectDispatchState,
  RunCheckpoint,
  UpdateIssuePlanInput,
  VerificationReport,
} from './types'

export const healthApi = {
  async get(): Promise<HealthInfo> {
    const raw = await api<unknown>('/health')
    const rec = isRecord(raw) ? raw : {}
    return {
      status: asString(rec['status']) ?? (asString(rec['ready']) !== null ? 'ready' : 'ok'),
      runtimeVersion:
        asString(rec['runtimeVersion']) ?? asString(rec['runtime_version']) ?? asString(rec['version']),
    }
  },
}

export const sessionApi = {
  /** 探测 Cookie 并恢复当前浏览器标签页的 CSRF 令牌。 */
  async probe(): Promise<boolean> {
    try {
      const session = await api<{ csrfToken: string }>('/session')
      setCsrfToken(session.csrfToken)
      return true
    } catch (error) {
      if (isAuthError(error)) return false
      throw error
    }
  },
  /**
   * 初次配对：一次性设置码换取 Cookie + CSRF 令牌。
   * 一次性设置码换取 Cookie 和 CSRF 令牌。
   */
  pair(code: string): Promise<PairResult> {
    return api<PairResult>('/session', { method: 'POST', body: { code } })
  },
  /** 为另一台浏览器生成一次性配对码；仅本机操作员（浏览器会话）可用。 */
  issuePairingCode(): Promise<{ code: string }> {
    return api<{ code: string }>('/session/pairing-code', { method: 'POST' })
  },
}

/**
 * MCP / 外部客户端的 Bearer 令牌（项目与权限双范围）。
 * 管理端点仅本机浏览器会话可用；密钥只在创建响应中出现一次。
 */
export const tokensApi = {
  async list(): Promise<Page<McpTokenInfo>> {
    return asPage<McpTokenInfo>(await api<unknown>('/tokens'))
  },
  create(input: { projectIds: Id[]; permissions: string[] }): Promise<CreatedToken> {
    return api<CreatedToken>('/tokens', { method: 'POST', body: input })
  },
  revoke(id: Id): Promise<{ revoked: boolean }> {
    return api<{ revoked: boolean }>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}

export const projectsApi = {
  async list(): Promise<Page<Project>> {
    return asPage<Project>(await api<unknown>('/projects'))
  },
  create(input: CreateProjectInput): Promise<Project> {
    return api<Project>('/projects', { method: 'POST', body: input })
  },
  dispatch(id: Id): Promise<ProjectDispatchState> {
    return api<ProjectDispatchState>(`/projects/${encodeURIComponent(id)}/dispatch`)
  },
  setPaused(id: Id, paused: boolean, expectedVersion: number): Promise<ProjectDispatchState> {
    return api<ProjectDispatchState>(`/projects/${encodeURIComponent(id)}/dispatch`, {
      method: 'PATCH', body: { paused, expectedVersion },
    })
  },
  checkReadiness(id: Id, expectedVersion: number): Promise<{ readiness: { ready: boolean; code: string | null; diagnostic: string | null }; dispatch: ProjectDispatchState }> {
    return api(`/projects/${encodeURIComponent(id)}/readiness`, {
      method: 'POST', body: { expectedVersion },
    })
  },
}

export const schedulerApi = {
  snapshot(projectId?: Id): Promise<SchedulerSnapshot> {
    return api<SchedulerSnapshot>('/scheduler', { query: { projectId } })
  },
  update(input: Omit<SchedulerSettings, 'version'> & { expectedVersion: number }): Promise<SchedulerSettings> {
    return api<SchedulerSettings>('/scheduler', { method: 'PUT', body: input })
  },
}

export interface ProfileCapabilities {
  providerRef: string
  modelId: string
  reasoningOptions: Array<{ value: string; name: string }>
}

export const profilesApi = {
  async list(): Promise<Page<Profile>> {
    return asPage<Profile>(await api<unknown>('/profiles'))
  },
  create(input: CreateProfileInput): Promise<Profile> {
    return api<Profile>('/profiles', { method: 'POST', body: input })
  },
  capabilities(providerRef: string, modelId: string): Promise<ProfileCapabilities> {
    return api<ProfileCapabilities>('/profiles/capabilities', {
      method: 'POST', body: { providerRef, modelId },
    })
  },
  update(id: Id, patch: Partial<CreateProfileInput> & { disabled?: boolean }, expectedRevision: number): Promise<Profile> {
    return api<Profile>(`/profiles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { ...patch, expectedRevision },
    })
  },
  async history(id: Id): Promise<ProfileHistoryEntry[]> {
    const raw = await api<unknown>(`/profiles/${encodeURIComponent(id)}/history`)
    const list = Array.isArray(raw) ? raw : asPage<unknown>(raw).items
    return list.map((entry): ProfileHistoryEntry => {
      const rec = isRecord(entry) ? entry : {}
      const issueIds = Array.isArray(rec['issueIds'])
        ? (rec['issueIds'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      const score =
        typeof rec['averageScore'] === 'number'
          ? (rec['averageScore'] as number)
          : typeof rec['score'] === 'number'
            ? (rec['score'] as number)
            : null
      const count =
        typeof rec['evaluatedCount'] === 'number'
          ? (rec['evaluatedCount'] as number)
          : typeof rec['count'] === 'number'
            ? (rec['count'] as number)
            : issueIds.length
      return {
        revision: typeof rec['revision'] === 'number' ? (rec['revision'] as number) : 0,
        averageScore: score,
        evaluatedCount: count,
        issueIds,
      }
    })
  },
}

function normalizeQuestion(raw: unknown): PendingQuestion | null {
  if (!isRecord(raw)) return null
  const id = asString(raw['id'])
  const runId = asString(raw['runId']) ?? asString(raw['run_id'])
  if (!id || !runId) return null
  const createdAt = asString(raw['createdAt']) ?? undefined
  const items: PendingQuestionItem[] = []
  const rawItems = raw['questions']
  if (Array.isArray(rawItems)) {
    for (const [index, item] of rawItems.entries()) {
      if (typeof item === 'string') {
        items.push({ id: `q${index}`, text: item })
      } else if (isRecord(item)) {
        const text = asString(item['text']) ?? asString(item['prompt']) ?? asString(item['question'])
        if (text) {
          const options = Array.isArray(item['options'])
            ? (item['options'] as unknown[]).filter((v): v is string => typeof v === 'string')
            : undefined
          const entry: PendingQuestionItem = {
            id: asString(item['id']) ?? `q${index}`,
            text,
          }
          if (asString(item['kind'])) entry.kind = asString(item['kind']) as string
          if (options && options.length > 0) entry.options = options
          if (typeof item['required'] === 'boolean') entry.required = item['required']
          items.push(entry)
        }
      }
    }
  } else {
    const prompt = asString(raw['prompt']) ?? asString(raw['text']) ?? asString(raw['question'])
    if (prompt) items.push({ id: 'response', text: prompt })
  }
  const result: PendingQuestion = { id, runId, questions: items }
  if (createdAt) result.createdAt = createdAt
  if (items.length === 0) result.raw = raw
  return result
}

function normalizeComment(raw: unknown): IssueComment | null {
  if (!isRecord(raw)) return null
  const text = asString(raw['text'])
  if (text === null) return null
  const comment: IssueComment = {
    id: asString(raw['id']) ?? `local-${Math.random().toString(36).slice(2)}`,
    issueId: asString(raw['issueId']) ?? '',
    text,
    createdAt: asString(raw['createdAt']) ?? new Date().toISOString(),
  }
  if (asString(raw['author'])) comment.author = asString(raw['author']) as string
  if (typeof raw['delivered'] === 'boolean') comment.delivered = raw['delivered']
  return comment
}

function normalizeDeliveryReport(raw: unknown): DeliveryReport {
  const rec = isRecord(raw) ? raw : {}
  return {
    stored: typeof rec['stored'] === 'boolean' ? rec['stored'] : true,
    delivered: typeof rec['delivered'] === 'boolean' ? rec['delivered'] : false,
  }
}

export const issuesApi = {
  async list(filter: { projectId?: string; status?: string; cursor?: string | null }): Promise<Page<Issue>> {
    return asPage<Issue>(
      await api<unknown>('/issues', {
        query: {
          projectId: filter.projectId,
          status: filter.status,
          cursor: filter.cursor ?? undefined,
        },
      }),
    )
  },
  create(input: CreateIssueInput, idempotencyKey: string): Promise<Issue> {
    return api<Issue>('/issues', { method: 'POST', body: input, idempotencyKey })
  },
  updatePlan(id: Id, input: UpdateIssuePlanInput): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/plan`, { method: 'PATCH', body: input })
  },
  async checkpoints(id: Id): Promise<RunCheckpoint[]> {
    const raw = await api<unknown>(`/issues/${encodeURIComponent(id)}/checkpoints`)
    return Array.isArray(raw) ? raw as RunCheckpoint[] : asPage<RunCheckpoint>(raw).items
  },
  resume(id: Id, checkpointId: Id, expectedIssueVersion: number): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/resume`, {
      method: 'POST', body: { checkpointId, expectedIssueVersion },
    })
  },
  async detail(id: Id): Promise<IssueDetail> {
    const raw = await api<unknown>(`/issues/${encodeURIComponent(id)}`)
    const rec = isRecord(raw) ? raw : {}
    const questions = Array.isArray(rec['questions'])
      ? (rec['questions'] as unknown[]).map(normalizeQuestion).filter((q): q is PendingQuestion => q !== null)
      : []
    const comments = Array.isArray(rec['comments'])
      ? (rec['comments'] as unknown[]).map(normalizeComment).filter((c): c is IssueComment => c !== null)
      : []
    return {
      issue: rec['issue'] as Issue,
      runs: Array.isArray(rec['runs']) ? (rec['runs'] as Run[]) : [],
      deliveries: Array.isArray(rec['deliveries']) ? (rec['deliveries'] as Delivery[]) : [],
      evaluation: (rec['evaluation'] as Evaluation | null | undefined) ?? null,
      applications: Array.isArray(rec['applications']) ? (rec['applications'] as Application[]) : [],
      questions,
      comments,
    }
  },
  async comment(id: Id, text: string): Promise<{ comment: IssueComment | null; report: DeliveryReport }> {
    const raw = await api<unknown>(`/issues/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: { text },
    })
    const rec = isRecord(raw) ? raw : {}
    const comment = normalizeComment(rec['comment'] ?? raw)
    return { comment, report: normalizeDeliveryReport(raw) }
  },
  cancel(id: Id, expectedIssueVersion: number): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { expectedIssueVersion },
    })
  },
  /** 仅失败（failed）状态的工单可重试：重新入队并保留历史。 */
  retry(id: Id, expectedIssueVersion: number): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: { expectedIssueVersion },
    })
  },
  accept(id: Id, deliveryId: Id, expectedIssueVersion: number): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      body: { deliveryId, expectedIssueVersion },
    })
  },
  rework(id: Id, deliveryId: Id, instructions: string, expectedIssueVersion: number): Promise<Issue> {
    return api<Issue>(`/issues/${encodeURIComponent(id)}/rework`, {
      method: 'POST',
      body: { deliveryId, instructions, expectedIssueVersion },
    })
  },
  evaluate(
    id: Id,
    input: { runId: Id; deliveryId?: Id; score: number; comment: string; expectedIssueVersion: number },
    idempotencyKey: string,
  ): Promise<Evaluation> {
    return api<Evaluation>(`/issues/${encodeURIComponent(id)}/evaluation`, {
      method: 'PUT',
      body: input,
      idempotencyKey,
    })
  },
  integrate(id: Id, deliveryId: Id, expectedIssueVersion: number, idempotencyKey: string): Promise<Application> {
    return api<Application>(`/issues/${encodeURIComponent(id)}/integrations`, {
      method: 'POST',
      body: { deliveryId, expectedIssueVersion },
      idempotencyKey,
    })
  },
}

export const runsApi = {
  checkpoint(id: Id): Promise<RunCheckpoint> {
    return api<RunCheckpoint>(`/runs/${encodeURIComponent(id)}/checkpoint`, { method: 'POST' })
  },
  async detail(id: Id): Promise<RunDetail> {
    const raw = await api<unknown>(`/runs/${encodeURIComponent(id)}`)
    const rec = isRecord(raw) ? raw : {}
    const run = (isRecord(rec['run']) ? rec['run'] : rec) as unknown as Run
    const facts: Record<string, unknown> = {}
    if (isRecord(rec['facts'])) Object.assign(facts, rec['facts'])
    if (isRecord(rec['observed'])) Object.assign(facts, rec['observed'])
    return { run, facts }
  },
  /** 实例的持久事件页（单调 sequence 游标）；与 SSE 增量互补。 */
  async events(id: Id, after?: string | null): Promise<Page<IssueEvent>> {
    return asPage<IssueEvent>(
      await api<unknown>(`/runs/${encodeURIComponent(id)}/events`, { query: { after: after ?? undefined } }),
    )
  },
  async sendMessage(id: Id, text: string): Promise<DeliveryReport> {
    const raw = await api<unknown>(`/runs/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { text },
    })
    return normalizeDeliveryReport(raw)
  },
  answerQuestion(id: Id, questionId: Id, answers: Record<string, string>): Promise<unknown> {
    return api<unknown>(`/runs/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/answer`, {
      method: 'POST',
      body: { answers },
    })
  },
}

export const applicationsApi = {
  verification(id: Id): Promise<VerificationReport | null> {
    return api<VerificationReport | null>(`/applications/${encodeURIComponent(id)}/verification`)
  },
  async detail(id: Id): Promise<ApplicationDetail> {
    const raw = await api<unknown>(`/applications/${encodeURIComponent(id)}`)
    const rec = isRecord(raw) ? raw : {}
    const application = (isRecord(rec['application']) ? rec['application'] : rec) as unknown as Application
    const evidence = Array.isArray(rec['evidence']) ? (rec['evidence'] as Evidence[]) : []
    return { application, evidence }
  },
  apply(id: Id, expectedTarget: string | null, idempotencyKey: string): Promise<Application> {
    return api<Application>(`/applications/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: { expectedTarget },
      idempotencyKey,
    })
  },
}

export const eventsApi = {
  async list(filter: { projectId?: string; after?: number | string | null }): Promise<Page<IssueEvent>> {
    return asPage<IssueEvent>(
      await api<unknown>('/events', {
        query: {
          projectId: filter.projectId,
          after: filter.after ?? undefined,
        },
      }),
    )
  },
  streamUrl(projectId: string | undefined, after: number | null): string {
    const params = new URLSearchParams()
    if (projectId) params.set('projectId', projectId)
    if (after !== null) params.set('after', String(after))
    const qs = params.toString()
    return `${API_PREFIX}/events/stream${qs ? `?${qs}` : ''}`
  },
}

/** 交付物文件的授权下载地址（同源 <a> 携带 Cookie）。 */
export function deliveryFileUrl(deliveryId: Id, path: string): string {
  return `${API_PREFIX}/deliveries/${encodeURIComponent(deliveryId)}/files/${encodeURIComponent(path)}`
}

export function checkpointFileUrl(checkpointId: Id, path: string): string {
  return `${API_PREFIX}/checkpoints/${encodeURIComponent(checkpointId)}/files/${encodeURIComponent(path)}`
}
