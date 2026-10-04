import { useEffect, useState } from 'react'
import { diffLines, type Change } from 'diff'
import { deliveriesApi, deliveryFileUrl } from '@/api/client'
import type { Delivery, DeliveryFileReview } from '@/api/types'
import { ErrorBox } from '@/components/ui'
import { FILE_CHANGE_KIND } from '@/lib/status'
import { formatBytes } from '@/lib/time'

const MAX_DIFF_CHARS = 160_000
const MAX_DIFF_LINES = 2_500
const MAX_EDIT_LENGTH = 4_000
const DIFF_TIMEOUT_MS = 500

interface DiffRow {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

type LineDiff =
  | { status: 'too-long' }
  | { status: 'aborted' }
  | { status: 'ok'; rows: DiffRow[]; clipped: boolean }

function lineDiff(before: string, after: string): LineDiff {
  if (before.length + after.length > MAX_DIFF_CHARS) return { status: 'too-long' }
  const options = { maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS }
  let changes: Change[] | undefined
  try {
    changes = diffLines(before, after, options)
  } catch {
    return { status: 'aborted' }
  }
  if (!changes) return { status: 'aborted' }
  const rows: DiffRow[] = []
  let clipped = false
  for (const part of changes) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    const pieces = part.value.split('\n')
    if (part.value.endsWith('\n')) pieces.pop()
    for (const text of pieces) {
      if (rows.length >= MAX_DIFF_LINES) {
        clipped = true
        break
      }
      rows.push({ kind, text })
    }
    if (clipped) break
  }
  return { status: 'ok', rows, clipped }
}

function canCompare(review: DeliveryFileReview): { before: string; after: string } | null {
  if (review.binary || review.truncated || review.unavailableReason) return null
  if (review.kind === 'added' && review.after !== null) return { before: '', after: review.after }
  if (review.kind === 'deleted' && review.before !== null) return { before: review.before, after: '' }
  if (review.kind === 'modified' && review.before !== null && review.after !== null) {
    return { before: review.before, after: review.after }
  }
  return null
}

export function DeliveryReview({ delivery }: { delivery: Delivery }) {
  const [path, setPath] = useState(delivery.files[0]?.path ?? '')
  const [review, setReview] = useState<DeliveryFileReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!path) {
      setReview(null)
      setLoading(false)
      setError(null)
      return
    }
    let stale = false
    setReview(null)
    setError(null)
    setLoading(true)
    void deliveriesApi
      .review(delivery.id, path)
      .then((value) => {
        if (stale) return
        setReview(value.path === path ? value : null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (stale) return
        setError(err)
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [delivery.id, path])

  if (delivery.files.length === 0) {
    return <p className="muted">这次交付没有文件变更。</p>
  }

  const selected = delivery.files.find((file) => file.path === path) ?? null
  const comparable = review ? canCompare(review) : null
  const diff = comparable ? lineDiff(comparable.before, comparable.after) : null
  const downloadable = selected !== null && selected.kind !== 'deleted'

  return (
    <div className="review-layout">
      <div>
        {delivery.files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={file.path === path ? 'file-pick active' : 'file-pick'}
            aria-pressed={file.path === path}
            onClick={() => setPath(file.path)}
          >
            <span className={`file-kind file-kind-${file.kind}`}>{FILE_CHANGE_KIND[file.kind]}</span>
            <span className="mono">{file.path}</span>
          </button>
        ))}
      </div>
      <div>
        {selected ? (
          <div className="meta-line" style={{ marginTop: 0, marginBottom: 8 }}>
            <span>{FILE_CHANGE_KIND[selected.kind]}</span>
            <span>{formatBytes(selected.size)}</span>
            {downloadable ? (
              <a className="btn btn-sm" href={deliveryFileUrl(delivery.id, selected.path)} download>
                下载冻结文件
              </a>
            ) : (
              <span>删除的文件在冻结交付里已经不存在，不能下载副本。</span>
            )}
          </div>
        ) : null}
        <p className="muted small">对比的是任务开始时的基线和这份冻结交付，不是项目目录现在的内容。</p>
        {loading ? <p className="muted">正在读取差异…</p> : null}
        {error ? <ErrorBox error={error} /> : null}
        {review?.binary ? <div className="notice-box">这是二进制文件，页面不显示文本差异。可以下载冻结文件。</div> : null}
        {review?.truncated ? (
          <div className="notice-box">{review.unavailableReason ?? '内容已截断，不能显示完整差异。请下载冻结文件。'}</div>
        ) : null}
        {review && !review.truncated && review.unavailableReason ? (
          <div className="notice-box">{review.unavailableReason}</div>
        ) : null}
        {review && !review.binary && !comparable && !review.unavailableReason && !loading ? (
          <p className="muted">这一侧没有可读文本，所以不显示逐行差异。</p>
        ) : null}
        {diff?.status === 'too-long' ? (
          <div className="notice-box">两边文本太长，页面不做逐行比较。请下载冻结文件查看。</div>
        ) : null}
        {diff?.status === 'aborted' ? (
          <div className="notice-box">两边相差太大，比较在时限内没有完成。页面不显示可能不完整的差异。请下载冻结文件查看。</div>
        ) : null}
        {diff?.status === 'ok' ? (
          <>
            {diff.clipped ? <div className="notice-box">差异很长，页面只显示前面一部分。</div> : null}
            <pre className="diff" aria-label="文件差异">
              {diff.rows.map((row, index) => (
                <div key={index} className={`diff-line${row.kind === 'add' ? ' diff-add' : row.kind === 'del' ? ' diff-del' : ''}`}>
                  {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
                  {row.text}
                </div>
              ))}
            </pre>
          </>
        ) : null}
        {review && !review.binary && review.after && !comparable ? (
          <details className="fold">
            <summary>查看已读到的冻结文本</summary>
            <pre className="diff">{review.after}</pre>
          </details>
        ) : null}
      </div>
    </div>
  )
}
