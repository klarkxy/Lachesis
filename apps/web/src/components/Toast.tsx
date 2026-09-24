import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface ToastApi {
  notify: (text: string) => void
  notifyError: (text: string) => void
}

const ToastContext = createContext<ToastApi>({ notify: () => {}, notifyError: () => {} })

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((text: string, kind: Toast['kind']) => {
    const id = nextId++
    setToasts((prev) => [...prev, { id, text, kind }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4200)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      notify: (text) => push(text, 'info'),
      notifyError: (text) => push(text, 'error'),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.kind === 'error' ? ' toast-error' : ''}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
