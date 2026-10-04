import type { Application, Issue } from '@/api/types'

export interface StageCopy {
  tone: 'neutral' | 'attention' | 'danger' | 'ok'
  stage: string
  next: string
}

function latestApplication(applications: Application[]): Application | undefined {
  return applications.reduce<Application | undefined>((latest, item) => {
    if (!latest || item.updatedAt > latest.updatedAt) return item
    return latest
  }, undefined)
}

/** 只有当前验收的交付才决定阶段和写入。更早的候选留在历史里。 */
export function applicationsForAcceptance(applications: Application[], acceptedDeliveryId: string | null): Application[] {
  if (!acceptedDeliveryId) return []
  return applications.filter((item) => item.deliveryId === acceptedDeliveryId)
}

export function latestReadyApplication(applications: Application[], acceptedDeliveryId: string | null): Application | undefined {
  return latestApplication(
    applicationsForAcceptance(applications, acceptedDeliveryId).filter((item) => item.status === 'ready'),
  )
}

function reportNote(accessMode: Issue['accessMode']): string {
  return accessMode === 'read-only' ? '这是只读报告任务，验收后可以不写入项目。' : ''
}

export function describeStage(input: {
  status: Issue['status']
  accessMode?: Issue['accessMode']
  applications: Application[]
  acceptedDeliveryId?: string | null
  pendingQuestions: number
  failureDiagnostic: string | null
}): StageCopy {
  const { status, accessMode, applications, pendingQuestions, failureDiagnostic } = input
  const optional = reportNote(accessMode)
  const acceptedDeliveryId = input.acceptedDeliveryId ?? null

  if (status === 'recovery_required') {
    return {
      tone: 'danger',
      stage: '需要恢复',
      next: '工作进程是否已经退出还不能确认，调度已停止。重启服务不会自动解除。请核对诊断、保留的工作区和备份，并取得进程已经退出的证据后再处理。',
    }
  }
  if (status === 'failed') {
    const reason = failureDiagnostic ? `${failureDiagnostic} ` : ''
    return {
      tone: 'danger',
      stage: '执行失败',
      next: `${reason}调度已停止。确认原因后可以重试。已有的执行和交付仍可查看。`,
    }
  }
  if (status === 'cancelled') {
    return {
      tone: 'neutral',
      stage: '已取消',
      next: '这张任务不会再被调度。已经产生的执行和交付还在。',
    }
  }
  if (status === 'needs_input' || (pendingQuestions > 0 && (status === 'running' || status === 'starting'))) {
    return {
      tone: 'attention',
      stage: '需要你回答',
      next: '执行停在问题上。提交回答后才会继续。',
    }
  }
  if (status === 'awaiting_review') {
    return {
      tone: 'attention',
      stage: '待验收',
      next: `请阅读冻结的交付和文件差异，再手动验收或发回返工。验收不会把文件写入项目。${optional}`,
    }
  }
  if (status === 'accepted') {
    const current = applicationsForAcceptance(applications, acceptedDeliveryId)
    const latest = latestApplication(current)
    const earlierDeliveryApplied = applications.some(
      (item) => item.status === 'applied' && item.deliveryId !== acceptedDeliveryId,
    )
    const thisDeliveryApplied = current.some((item) => item.status === 'applied')
    const earlierNote = thisDeliveryApplied
      ? '这份交付有过一次已经完成的写入。'
      : earlierDeliveryApplied
        ? '项目里可能还有更早一次已经写入的内容。'
        : ''
    if (!latest) {
      if (accessMode === 'read-only') {
        return {
          tone: 'ok',
          stage: '报告已验收',
          next: earlierDeliveryApplied
            ? '验收已完成。这是只读报告，不必写入项目。项目里可能还有更早一次交付的内容。'
            : '验收已完成。这是只读报告，可以到此结束，不必写入项目。',
        }
      }
      return {
        tone: 'ok',
        stage: '已验收，尚未写入项目',
        next: earlierDeliveryApplied
          ? '这次验收的交付还没有写入。项目里可能还有更早一次已经写入的内容。要写入这次，先准备候选，再单独确认。'
          : '验收已完成，项目文件还没有变化。要写入的话，先准备候选，再单独确认。',
      }
    }
    if (latest.status === 'queued' || latest.status === 'integrating') {
      return {
        tone: 'neutral',
        stage: '正在准备候选',
        next: earlierNote
          ? `这次的候选还没就绪。${earlierNote}${optional}`
          : `候选还没就绪，项目尚未写入。${optional}`,
      }
    }
    if (latest.status === 'ready') {
      const target = latest.expectedTarget ?? '由服务根据项目决定'
      return {
        tone: 'attention',
        stage: '候选已就绪，尚未写入',
        next: earlierNote
          ? `确认之后才会把这次的冻结交付写入本地项目。目标：${target}。${earlierNote}${optional}`
          : `确认之后才会把冻结交付写入本地项目。目标：${target}。${optional}`,
      }
    }
    if (latest.status === 'applying') {
      return {
        tone: 'neutral',
        stage: '正在写入项目',
        next: `写入还在进行。完成之前不要把它当成已经成功。${earlierNote}`,
      }
    }
    if (latest.status === 'applied') {
      const result = latest.resultTarget ? `结果位置：${latest.resultTarget}。` : ''
      return { tone: 'ok', stage: '已写入项目', next: `本地项目已经更新。${result}` }
    }
    if (latest.status === 'conflict') {
      const reason = latest.diagnostic ?? '准备候选时发生冲突。查看诊断后可以重新准备。'
      return {
        tone: 'danger',
        stage: '候选有冲突，尚未写入',
        next: earlierNote ? `${reason}${earlierNote}` : reason,
      }
    }
    if (latest.status === 'failed') {
      const reason = latest.diagnostic ?? '写入没有完成。'
      return {
        tone: 'danger',
        stage: '写入失败',
        next: earlierNote
          ? `${reason}${earlierNote}可以重新准备候选。`
          : `${reason}项目不一定包含这次交付。可以重新准备候选。`,
      }
    }
    const reason = latest.diagnostic ?? '写入中断。'
    return {
      tone: 'danger',
      stage: '写入需要恢复',
      next: `${reason}${earlierNote}目标项目可能停在中间状态。重启服务不会自动解除，需要可以核对的恢复证据。`,
    }
  }
  if (status === 'starting') {
    return { tone: 'neutral', stage: '正在启动', next: '执行环境正在准备。这里不显示虚构的完成百分比。' }
  }
  if (status === 'running') {
    return { tone: 'neutral', stage: '执行中', next: '可以补充说明，或打开这次执行发送消息。没有单独的进度条。' }
  }
  if (status === 'blocked') {
    return { tone: 'attention', stage: '等待依赖', next: '它依赖的任务还没有写入项目，所以这一张还不能开始。' }
  }
  return { tone: 'neutral', stage: '待开始', next: '任务在队列里。调度条件满足后会开始执行。' }
}
