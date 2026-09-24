/** 时间展示：全部来自服务端 ISO 时间戳，不虚构。 */

export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const delta = Date.now() - t
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return formatDateTime(iso)
}

/** 由 startedAt/endedAt 计算的真实时长；运行中由调用方传入当前时刻。 */
export function formatDuration(startIso: string | null, endIso: string | null, now: number): string | null {
  if (!startIso) return null
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return null
  const end = endIso ? new Date(endIso).getTime() : now
  if (Number.isNaN(end)) return null
  let seconds = Math.max(0, Math.round((end - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

export function formatBytes(size: number | null): string {
  if (size === null || size === undefined) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
