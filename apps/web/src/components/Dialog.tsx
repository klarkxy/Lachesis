import { useEffect, useRef, type ReactNode } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  /** 提交中等场景禁止关闭 */
  busy?: boolean
}

/** 基于原生 <dialog> 的模态框：自带 Esc 关闭、焦点圈定与背景屏蔽。 */
export function Dialog({ open, onClose, title, children, footer, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="lx-dialog"
      aria-label={title}
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-head">
        <span className="dialog-title">{title}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy} aria-label="关闭对话框">
          关闭
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </dialog>
  )
}
