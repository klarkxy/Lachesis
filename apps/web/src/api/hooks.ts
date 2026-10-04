import { useCallback, useEffect, useRef, useState } from 'react'
import type { IssueEvent } from './types'
import { eventsApi } from './client'

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: unknown
  refetch: () => void
}

/** 同一资源的刷新保留页面；切换资源立即隐藏旧数据。 */
export function useQuery<T>(fn: () => Promise<T>, deps: readonly unknown[]): QueryState<T> {
  const [state, setState] = useState<{ key: readonly unknown[]; data: T | null; loading: boolean; error: unknown }>(
    () => ({ key: [...deps], data: null, loading: true, error: null }),
  )
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let cancelled = false
    const key = [...deps]
    const sameKey = (other: readonly unknown[]) => key.length === other.length && key.every((value, index) => Object.is(value, other[index]))
    setState((previous) => {
      const data = sameKey(previous.key) ? previous.data : null
      return { key, data, loading: data === null, error: null }
    })
    fnRef.current()
      .then((value) => {
        if (!cancelled) {
          setState({ key, data: value, loading: false, error: null })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((previous) => ({ key, data: sameKey(previous.key) ? previous.data : null, loading: false, error: err }))
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const refetch = useCallback(() => setTick((t) => t + 1), [])
  const current = state.key.length === deps.length && deps.every((value, index) => Object.is(value, state.key[index]))
  return current ? { data: state.data, loading: state.loading, error: state.error, refetch }
    : { data: null, loading: true, error: null, refetch }
}

interface EventStreamState {
  events: IssueEvent[]
  connected: boolean
  error: boolean
  reset: () => void
}

/**
 * 项目事件流：先用持久事件页补齐历史，再挂 SSE 增量。
 * 断线后按最后游标重连（同一事件 ID 语义，契约第 35-36 行）。
 */
export function useEventStream(projectId: string | undefined, enabled: boolean): EventStreamState {
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let source: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let last: number | null = null
    const seen = new Set<number>()

    const push = (event: IssueEvent) => {
      if (typeof event.sequence === 'number') {
        if (seen.has(event.sequence)) return
        seen.add(event.sequence)
        last = event.sequence
      }
      setEvents((prev) => {
        const next = [...prev, event]
        return next.length > 500 ? next.slice(next.length - 500) : next
      })
    }

    const open = () => {
      if (disposed) return
      setConnected(false)
      source = new EventSource(eventsApi.streamUrl(projectId, last))
      source.onopen = () => {
        if (!disposed) {
          setConnected(true)
          setError(false)
        }
      }
      source.onmessage = (message) => {
        try {
          push(JSON.parse(message.data as string) as IssueEvent)
        } catch {
          /* 忽略无法解析的帧 */
        }
      }
      source.onerror = () => {
        source?.close()
        source = null
        if (disposed) return
        setConnected(false)
        setError(true)
        retryTimer = setTimeout(open, 3000)
      }
    }

    setEvents([])
    setError(false)
    eventsApi
      .list({ projectId })
      .then((page) => {
        if (disposed) return
        for (const event of page.items) push(event)
      })
      .catch(() => {
        if (!disposed) setError(true)
      })
      .finally(() => {
        open()
      })

    return () => {
      disposed = true
      source?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [projectId, enabled, tick])

  const reset = useCallback(() => setTick((t) => t + 1), [])
  return { events, connected, error, reset }
}

/** 每秒走表，用于真实运行时长（由 startedAt/endedAt 计算，不是进度假象）。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
