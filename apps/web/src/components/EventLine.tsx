import { JsonDetails } from '@/components/ui'
import { summarizeEvent } from '@/lib/events'
import { formatClock, formatDateTime } from '@/lib/time'

export function EventLine({
  event,
}: {
  event: { sequence: number; type: string; data: unknown; createdAt: string }
}) {
  return (
    <div className="event">
      <span className="event-time" title={formatDateTime(event.createdAt)}>
        {formatClock(event.createdAt)}
      </span>
      <div>
        <div className="event-summary">{summarizeEvent(event.type, event.data)}</div>
        <JsonDetails data={{ type: event.type, data: event.data }} summary="原始记录" />
      </div>
    </div>
  )
}
