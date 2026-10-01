import { parentPort, workerData } from 'node:worker_threads'
import { openDomain, type Actor } from '../src/index.ts'

const data = workerData as { databasePath: string; actor: Actor; profileId: string }

const domain = openDomain({
  databasePath: data.databasePath,
  recoverInterrupted: false,
})

try {
  const claim = domain.claimReadyIssue(data.actor, { profileId: data.profileId })
  parentPort!.postMessage({
    ok: true,
    runId: claim?.run.id ?? null,
    issueId: claim?.issue.id ?? null,
    generation: claim?.generation ?? null,
  })
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    code: error && typeof error === 'object' && 'code' in error ? String((error as { code: string }).code) : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  domain.close()
}
