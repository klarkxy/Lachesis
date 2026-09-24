import { WorkspaceError } from './errors.ts'
import type { WorkerStopProof } from './types.ts'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Freeze requires an explicit stop proof. A missing object or an empty proof
 * is rejected so callers cannot skip the worker-liveness check.
 */
export async function assertWorkerStopped(proof: WorkerStopProof | undefined): Promise<void> {
  if (proof === undefined) {
    throw new WorkspaceError('worker_unproven', 'Freeze requires an explicit worker stop proof')
  }
  const hasRange = proof.rangeExited !== undefined
  const hasPid = proof.pid !== undefined
  const hasConfirm = proof.confirm !== undefined
  if (!hasRange && !hasPid && !hasConfirm) {
    throw new WorkspaceError('worker_unproven', 'Worker stop proof is empty')
  }
  if (proof.rangeExited === false) {
    throw new WorkspaceError('worker_running', 'Worker execution range has not exited')
  }
  if (hasPid) {
    const pid = proof.pid!
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new WorkspaceError('worker_unproven', 'Worker pid is invalid')
    }
    if (pidAlive(pid)) {
      throw new WorkspaceError('worker_running', `Worker pid ${pid} is still alive`)
    }
  }
  if (hasConfirm) {
    const stopped = await proof.confirm!()
    if (!stopped) {
      throw new WorkspaceError('worker_running', 'Worker stop confirmation returned false')
    }
  }
}
