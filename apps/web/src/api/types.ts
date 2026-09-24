/**
 * 线类型：核心实体直接复用 @lachesis/contracts（只读引用，单一日志源）。
 * 组合响应（IssueDetail 等）在 api-contract.md 中有结构描述但 contracts 未导出，
 * 此处按文档描述补齐，并对不确定字段做防御性处理。
 */
export type {
  Id,
  ISODate,
  WorkspaceKind,
  IssueStatus,
  RunStatus,
  ApplicationStatus,
  Project,
  Profile,
  ProfileRevision,
  Dispatch,
  Issue,
  Run,
  FileChange,
  Delivery,
  Evidence,
  Evaluation,
  Application,
  IssueEvent,
  Page,
  ApiError,
  ApiSuccess,
  CreateIssueInput,
  CreateProfileInput,
  CreateProjectInput,
  SchedulerSettings,
  ProjectDispatchState,
  DispatchDecision,
  DispatchReason,
  SchedulerSnapshot,
  RunCheckpoint,
  UpdateIssuePlanInput,
  VerificationReport,
} from '@lachesis/contracts'

import type {
  Application,
  Delivery,
  Evaluation,
  Evidence,
  Id,
  ISODate,
  Issue,
  Run,
} from '@lachesis/contracts'

/** 工单补充说明（POST /issues/:id/comments 的存储记录）。契约未导出形状，按防御性假设。 */
export interface IssueComment {
  id: Id
  issueId: Id
  text: string
  author?: string
  createdAt: ISODate
  /** 是否已送达执行实例；契约要求"先存储、送达状态单独上报"。 */
  delivered?: boolean
}

/** 执行实例挂起问题的一个子项。契约未导出形状，UI 做防御性归一化。 */
export interface PendingQuestionItem {
  id: string
  text: string
  kind?: string
  options?: string[]
  required?: boolean
}

/** 一次待答复提问。 */
export interface PendingQuestion {
  id: Id
  runId: Id
  createdAt?: ISODate
  questions: PendingQuestionItem[]
  /** 未识别形状时保留原文，UI 提供自由文本答复。 */
  raw?: unknown
}

/** GET /issues/:id 的组合响应（api-contract.md 第 22 行）。 */
export interface IssueDetail {
  issue: Issue
  runs: Run[]
  deliveries: Delivery[]
  evaluation: Evaluation | null
  applications: Application[]
  questions: PendingQuestion[]
  comments: IssueComment[]
}

/** GET /runs/:id：Run 与观测到的执行事实。事实集合契约未枚举，原样展示。 */
export interface RunDetail {
  run: Run
  facts: Record<string, unknown>
}

/** GET /applications/:id：Application 与验证证据。 */
export interface ApplicationDetail {
  application: Application
  evidence: Evidence[]
}

/** POST /runs/:id/messages 的"存储 vs 送达"结果。 */
export interface DeliveryReport {
  stored: boolean
  delivered: boolean
}

/** GET /profiles/:id/history：每修订的均分、已评工单数与贡献工单。 */
export interface ProfileHistoryEntry {
  revision: number
  averageScore: number | null
  evaluatedCount: number
  issueIds: Id[]
}

/** GET /health：就绪状态与锁定的运行时版本。字段名未在契约中枚举，做防御读取。 */
export interface HealthInfo {
  status: string
  runtimeVersion: string | null
}

/** 配对成功的返回。端点本身契约未列出（见交付报告 API 缺口）。 */
export interface PairResult {
  csrfToken: string
}

/** GET /tokens 的令牌记录：仅元数据，服务端永不再次返回密钥本体。 */
export interface McpTokenInfo {
  id: Id
  projectIds: Id[]
  permissions: string[]
  /** 服务端以 Unix 毫秒时间戳返回。 */
  createdAt: number
}

/** POST /tokens 的创建响应：密钥（token）仅此一次出现在响应中。 */
export interface CreatedToken {
  token: string
  id: Id
}
