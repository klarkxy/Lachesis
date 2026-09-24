import { useState, type ReactNode } from 'react'
import { ApiError } from '@/api/client'

export function LoadingBlock({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action}
    </div>
  )
}

export function describeError(error: unknown): { message: string; code: string | null } {
  if (error instanceof ApiError) return { message: error.message, code: error.code }
  if (error instanceof Error) return { message: error.message, code: null }
  return { message: '发生未知错误。', code: null }
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, code } = describeError(error)
  return (
    <div className="error-box" role="alert">
      {message}
      {code ? <span className="code">{code}</span> : null}
      {onRetry ? (
        <button type="button" className="btn btn-sm" style={{ marginLeft: 10 }} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

export function StatusPill({ label, color, strong = false }: { label: string; color: string; strong?: boolean }) {
  return (
    <span className={`pill${strong ? ' pill-strong' : ''}`}>
      <span className="dot" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  )
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} aria-hidden="true" />
}

export function IdTag({ value, title }: { value: string; title?: string }) {
  const short = value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
  return (
    <span className="id-tag" title={title ?? value}>
      {short}
    </span>
  )
}

/** 折叠展示服务端原始数据（事件负载、未枚举字段）。 */
export function JsonDetails({ data, summary = '查看原始数据' }: { data: unknown; summary?: string }) {
  const [open, setOpen] = useState(false)
  let text: string
  try {
    text = JSON.stringify(data, null, 2) ?? 'null'
  } catch {
    text = String(data)
  }
  return (
    <div className="event-data">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '收起' : summary}
      </button>
      {open ? <pre>{text}</pre> : null}
    </div>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error ? <div className="field-hint">{hint}</div> : null}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/** 品牌标记：纺锤上被丈量的线。 */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#14635B" />
      <path
        d="M9 22.5c4.5-1 8-3.2 10-6.5 1.4-2.3 2.4-4.8 4-6.5"
        fill="none"
        stroke="#F5F6F4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="9" cy="22.5" r="2.6" fill="#F5F6F4" />
      <path
        d="M13.2 20.9l1.6 1.4M17.2 17.6l1.6 1.4M20.6 13.4l1.6 1.4"
        stroke="#9FC4BC"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
