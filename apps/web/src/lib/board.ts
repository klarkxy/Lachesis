import type { IssueStatus } from '@/api/types'

export const BOARD_COLUMNS = [
  {
    id: 'start',
    label: '待开始',
    hint: '排队，或还在等依赖写入项目',
    statuses: ['queued', 'blocked'] as const,
  },
  {
    id: 'run',
    label: '执行中',
    hint: '正在启动或执行',
    statuses: ['starting', 'running'] as const,
  },
  {
    id: 'attention',
    label: '需要处理',
    hint: '要回答、已失败、已取消或待恢复',
    statuses: ['needs_input', 'failed', 'cancelled', 'recovery_required'] as const,
  },
  {
    id: 'review',
    label: '待验收',
    hint: '交付已冻结，等你验收',
    statuses: ['awaiting_review'] as const,
  },
  {
    id: 'accepted',
    label: '已验收',
    hint: '已验收。写入项目是另一步',
    statuses: ['accepted'] as const,
  },
] as const

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id']

const COLUMN_BY_STATUS = new Map<string, BoardColumnId>(
  BOARD_COLUMNS.flatMap((column) => column.statuses.map((status) => [status, column.id] as const)),
)

export function columnForStatus(status: IssueStatus | string): BoardColumnId {
  return COLUMN_BY_STATUS.get(status) ?? 'attention'
}
