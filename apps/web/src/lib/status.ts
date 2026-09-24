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
  queued: { label: '排队中', color: 'var(--st-queued)' },
  blocked: { label: '已阻塞', color: 'var(--st-blocked)' },
  starting: { label: '启动中', color: 'var(--st-running)' },
  running: { label: '执行中', color: 'var(--st-running)' },
  needs_input: { label: '等待输入', color: 'var(--st-input)' },
  awaiting_review: { label: '待验收', color: 'var(--st-review)' },
  accepted: { label: '已验收', color: 'var(--st-ok)' },
  failed: { label: '失败', color: 'var(--st-fail)' },
  cancelled: { label: '已取消', color: 'var(--st-off)' },
  recovery_required: { label: '待恢复', color: 'var(--st-fail)' },
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
  queued: { label: '排队中', color: 'var(--st-queued)' },
  integrating: { label: '集成中', color: 'var(--st-running)' },
  conflict: { label: '存在冲突', color: 'var(--st-blocked)' },
  ready: { label: '可应用', color: 'var(--st-review)' },
  applying: { label: '应用中', color: 'var(--st-running)' },
  applied: { label: '已应用', color: 'var(--st-ok)' },
  failed: { label: '应用失败', color: 'var(--st-fail)' },
  recovery_required: { label: '需要恢复', color: 'var(--st-fail)' },
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

export const FILE_CHANGE_KIND: Record<FileChange['kind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

export const EVIDENCE_KIND: Record<Evidence['kind'], string> = {
  tool_result: '工具结果',
  model_report: '模型自述',
  verification: '验证',
  lifecycle: '生命周期',
}

export const EVIDENCE_OUTCOME: Record<Evidence['outcome'], StatusMeta> = {
  passed: { label: '通过', color: 'var(--st-ok)' },
  failed: { label: '未通过', color: 'var(--st-fail)' },
  unknown: { label: '未知', color: 'var(--st-off)' },
}
