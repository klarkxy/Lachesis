const EVENT_SUMMARY: Record<string, string> = {
  'project.created': '项目已创建',
  'project.dispatch_updated': '项目是否接单已更新',
  'project.environment_blocked': '环境检查未通过，调度已暂停',
  'project.environment_cleared': '环境检查已通过',
  'issue.created': '任务已创建',
  'issue.plan_updated': '执行前的依赖和路径已更新',
  'issue.commented': '补充说明已保存',
  'issue.cancelled': '已请求取消任务',
  'issue.retried': '任务已重新排队',
  'issue.accepted': '交付已验收',
  'issue.reworked': '任务已发回返工',
  'issue.blocked': '任务被依赖挡住，尚未开始',
  'issue.unblocked': '依赖已满足，任务可以开始',
  'issue.claimed': '任务已被领取，准备执行',
  'issue.started': '任务开始执行',
  'issue.awaiting_review': '执行结束，交付已冻结，等待验收',
  'issue.failed': '执行失败，调度已停止',
  'issue.recovery_required': '进程退出还不能确认，需要恢复',
  'issue.recovered': '任务已从待恢复状态继续',
  'issue.checkpoint_resumed': '已从检查点继续执行',
  'run.started': '一次执行已启动',
  'run.bound': '执行输入已绑定到当时的基线',
  'run.preparation_deferred': '执行准备被推迟',
  'run.completed': '执行完成，并生成了冻结交付',
  'run.failed': '这次执行失败',
  'run.cancelled': '这次执行已取消',
  'run.interrupted': '这次执行中断',
  'run.recovery_required': '这次执行需要确认进程已经退出',
  'run.checkpoint_recorded': '已保存未完成的检查点',
  'question.asked': '执行中提出了需要你回答的问题',
  'question.answered': '问题已答复',
  'evaluation.recorded': '评价已记录，并记到对应的执行配置修订',
  'application.created': '已创建集成候选，尚未写入项目',
  'application.applying': '开始把候选写入项目',
  'application.updated': '集成候选的状态已更新',
  'application.failed': '写入项目失败',
  'application.recovery_required': '写入项目的过程需要恢复',
}

function diagnosticOf(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const value = (data as Record<string, unknown>).diagnostic
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  return text.length > 280 ? `${text.slice(0, 280)}…` : text
}

/** 给人读的事件摘要。未知类型保留原名，不把它说成进度。 */
export function summarizeEvent(type: string, data: unknown): string {
  const base = EVENT_SUMMARY[type] ?? `记录了一条事件（${type}）`
  const wantsDetail = /fail|recovery|deferred|blocked|conflict/.test(type)
  const diagnostic = wantsDetail ? diagnosticOf(data) : null
  return diagnostic ? `${base}：${diagnostic}` : base
}
