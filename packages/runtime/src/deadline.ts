/** ACP cancellation is cooperative, so the deadline must also settle locally. */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms} ms`)), ms)
  let rejectAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        if (controller.signal.aborted) rejectAbort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}

export function finiteTimeout(name: string, value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new Error(`${name} must be a positive finite integer no greater than 2147483647`)
  }
  return result
}
