import type {
  ApplicationStatus,
  Evidence,
  FileChange,
  IssueStatus,
  RunStatus,
} from '@/api/types'

export interface StatusMeta {
  label: string
  /** 对应 styles.css 中的 --st-* 变量 */
  color: string
}

const ISSUE_STATUS: Record<IssueStatus, StatusMeta> = {
  queued: { label: '排队等待', color: 'var(--st-queued)' },
  blocked: { label: '等待依赖', color: 'var(--st-blocked)' },
  starting: { label: '正在启动', color: 'var(--st-running)' },
  running: { label: '执行中', color: 'var(--st-running)' },
  needs_input: { label: '需要回答', color: 'var(--st-input)' },
  awaiting_review: { label: '待验收', color: 'var(--st-review)' },
  accepted: { label: '已验收', color: 'var(--st-ok)' },
  failed: { label: '执行失败', color: 'var(--st-fail)' },
  cancelled: { label: '已取消', color: 'var(--st-off)' },
  recovery_required: { label: '需要恢复', color: 'var(--st-fail)' },
}

const RUN_STATUS: Record<RunStatus, StatusMeta> = {
  starting: { label: '启动中', color: 'var(--st-running)' },
  running: { label: '运行中', color: 'var(--st-running)' },
  needs_input: { label: '等待输入', color: 'var(--st-input)' },
  cancelling: { label: '取消中', color: 'var(--st-blocked)' },
  completed: { label: '已完成', color: 'var(--st-ok)' },
  failed: { label: '失败', color: 'var(--st-fail)' },
  cancelled: { label: '已取消', color: 'var(--st-off)' },
  interrupted: { label: '已中断', color: 'var(--st-off)' },
  recovery_required: { label: '待恢复', color: 'var(--st-fail)' },
}

const APPLICATION_STATUS: Record<ApplicationStatus, StatusMeta> = {
  queued: { label: '正在排队准备', color: 'var(--st-queued)' },
  integrating: { label: '正在准备候选', color: 'var(--st-running)' },
  conflict: { label: '候选有冲突', color: 'var(--st-blocked)' },
  ready: { label: '候选已就绪，尚未写入', color: 'var(--st-review)' },
  applying: { label: '正在写入项目', color: 'var(--st-running)' },
  applied: { label: '已写入项目', color: 'var(--st-ok)' },
  failed: { label: '写入失败', color: 'var(--st-fail)' },
  recovery_required: { label: '写入需要恢复', color: 'var(--st-fail)' },
}

const FALLBACK: StatusMeta = { label: '未知', color: 'var(--st-off)' }

export function issueStatusMeta(status: string): StatusMeta {
  return (ISSUE_STATUS as Record<string, StatusMeta>)[status] ?? { ...FALLBACK, label: status }
}

export function runStatusMeta(status: string): StatusMeta {
  return (RUN_STATUS as Record<string, StatusMeta>)[status] ?? { ...FALLBACK, label: status }
}

export function applicationStatusMeta(status: string): StatusMeta {
  return (APPLICATION_STATUS as Record<string, StatusMeta>)[status] ?? { ...FALLBACK, label: status }
}

/** 看板和列表上的可读状态。任务本身的 status 不变；已验收时用列表投影里的写入状态区分。 */
export function issueBoardMeta(issue: {
  status: string
  accessMode?: string | null
  applicationStatus?: ApplicationStatus | null
}): StatusMeta {
  if (issue.status !== 'accepted') return issueStatusMeta(issue.status)
  const reportOnly = issue.accessMode === 'read-only'
  switch (issue.applicationStatus) {
    case 'queued':
    case 'integrating':
      return { label: '正在准备候选', color: 'var(--st-running)' }
    case 'ready':
      return { label: '候选就绪', color: 'var(--st-review)' }
    case 'applying':
      return { label: '正在写入', color: 'var(--st-running)' }
    case 'applied':
      return { label: '已写入项目', color: 'var(--st-ok)' }
    case 'conflict':
      return { label: '候选有冲突', color: 'var(--st-blocked)' }
    case 'failed':
      return { label: '写入失败', color: 'var(--st-fail)' }
    case 'recovery_required':
      return { label: '写入需要恢复', color: 'var(--st-fail)' }
    default:
      return reportOnly
        ? { label: '报告已验收', color: 'var(--st-ok)' }
        : { label: '已验收·尚未写入', color: 'var(--st-ok)' }
  }
}

export const FILE_CHANGE_KIND: Record<FileChange['kind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

export const EVIDENCE_KIND: Record<Evidence['kind'], string> = {
  tool_result: '工具结果',
  model_report: '模型自述，不是验证结论',
  verification: '验证证据',
  lifecycle: '生命周期记录，不是验证结论',
}

export const EVIDENCE_OUTCOME: Record<Evidence['outcome'], StatusMeta> = {
  passed: { label: '通过', color: 'var(--st-ok)' },
  failed: { label: '未通过', color: 'var(--st-fail)' },
  unknown: { label: '未知', color: 'var(--st-off)' },
}
