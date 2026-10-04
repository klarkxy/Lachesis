import { stat } from 'node:fs/promises'
import { loadBaseline } from './baseline.ts'
import { WorkspaceError } from './errors.ts'
import { loadDeliveryRun, loadManifest } from './freeze.ts'
import { looksBinary } from './hash.ts'
import { blobSize, catBlob, ensureGitTool, gitBlobId, listTree, serviceGitPath } from './objects.ts'
import { assertRelativePosix } from './paths.ts'
import type { ArtifactStore } from './store.ts'

const MAX_PREVIEW_BYTES = 128 * 1024

export interface DeliveryFileReview {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before: string | null
  after: string | null
  binary: boolean
  truncated: boolean
  unavailableReason: string | null
}

/** Review only manifest members, using frozen blobs and the cumulative origin baseline. */
export async function reviewDeliveryFile(store: ArtifactStore, gitBin: string, deliveryId: string, path: string): Promise<DeliveryFileReview> {
  const manifest = await loadManifest(store, deliveryId)
  const posix = assertRelativePosix('path', path)
  const file = manifest.files.find((entry) => entry.path === posix)
  if (!file) throw new WorkspaceError('not_found', `Delivery ${deliveryId} has no file ${posix}`)
  const review: DeliveryFileReview = {
    path: posix, kind: file.kind, before: null, after: null,
    binary: file.binary, truncated: false, unavailableReason: null,
  }
  if (file.binary) return review

  const decode = (bytes: Uint8Array): string | null => {
    if (looksBinary(bytes)) { review.binary = true; return null }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { review.binary = true; return null }
  }
  const boundedBlob = async (sha: string): Promise<Uint8Array | null> => {
    if ((await stat(store.blobPath(sha))).size > MAX_PREVIEW_BYTES) {
      review.truncated = true
      return null
    }
    const bytes = await store.getBlob(sha)
    if (bytes.byteLength > MAX_PREVIEW_BYTES) { review.truncated = true; return null }
    return bytes
  }

  if (file.kind !== 'deleted') {
    if (!file.sha256) throw new WorkspaceError('store_corrupt', 'Frozen delivery has no file hash')
    const bytes = await boundedBlob(file.sha256)
    if (bytes) review.after = decode(bytes)
  }
  if (file.kind !== 'added' && !review.binary) {
    try {
      const run = await loadDeliveryRun(store, deliveryId)
      if (run.runId !== manifest.runId || run.kind !== manifest.kind || run.baseRef !== manifest.baseRef) {
        throw new WorkspaceError('store_corrupt', 'Frozen delivery input does not match its manifest')
      }
      let bytes: Uint8Array | null = null
      if (manifest.kind === 'git') {
        const origin = manifest.originBaseRef ?? run.originBaseRef ?? manifest.baseRef
        if (!origin || !/^[0-9a-f]{40,64}$/i.test(origin)) throw new WorkspaceError('store_corrupt', 'Original commit is unavailable')
        const tool = await ensureGitTool(store.root, gitBin)
        const repo = run.layout === 'phase1' ? (run.serviceGit ?? serviceGitPath(store.root, run.projectRoot)) : run.projectRoot
        const entry = (await listTree(tool, repo, origin)).find((item) => item.path === posix)
        if (!entry) throw new WorkspaceError('not_found', 'Original file is unavailable')
        if (await blobSize(tool, repo, entry.sha) > MAX_PREVIEW_BYTES) review.truncated = true
        else {
          bytes = await catBlob(tool, repo, entry.sha)
          if (gitBlobId(bytes, entry.sha.length) !== entry.sha) throw new WorkspaceError('store_corrupt', 'Original Git bytes do not match')
        }
      } else if (run.baselineId) {
        const baseline = await loadBaseline(store, run.baselineId)
        if (manifest.baseRef !== `files:${baseline.digest}`) throw new WorkspaceError('store_corrupt', 'Original file baseline does not match the delivery')
        const entry = baseline.files.find((item) => item.path === posix)
        if (!entry) throw new WorkspaceError('not_found', 'Original file is unavailable')
        bytes = await boundedBlob(entry.sha256)
      } else if (run.baselinePath) {
        // Historical directory captures have no per-file immutable digest. Do not
        // rescan an unbounded directory or present unverifiable bytes as a baseline.
        throw new WorkspaceError('not_found', 'Historical run has no immutable per-file baseline')
      } else throw new WorkspaceError('not_found', 'Original snapshot is unavailable')
      if (bytes) {
        if (bytes.byteLength > MAX_PREVIEW_BYTES) review.truncated = true
        else review.before = decode(bytes)
      }
    } catch (error) {
      if (!(error instanceof WorkspaceError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      review.unavailableReason = '原始版本暂时无法读取，不能显示完整差异。交付文件仍可查看或下载。'
    }
  }
  if (review.binary) { review.before = null; review.after = null }
  if (review.truncated) review.unavailableReason = '文件超过 128 KB，已省略超限内容，不能显示完整差异。请下载交付文件检查。'
  return review
}
