import { useState, type FormEvent } from 'react'
import { runsApi } from '@/api/client'
import type { PendingQuestion } from '@/api/types'
import { ErrorBox, JsonDetails } from '@/components/ui'

/**
 * 执行实例的待答复提问。仅针对仍处于 pending 的问题渲染表单；
 * 提交 POST /runs/:id/questions/:questionId/answer { answers }。
 */
export function QuestionCard({
  question,
  onAnswered,
}: {
  question: PendingQuestion
  onAnswered: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [freeform, setFreeform] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const knownItems = question.questions
  const valid =
    knownItems.length > 0
      ? knownItems.every((item) => !item.required || (values[item.id] ?? '').trim())
      : freeform.trim()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const answers: Record<string, string> =
      knownItems.length > 0
        ? Object.fromEntries(knownItems.map((item) => [item.id, (values[item.id] ?? '').trim()]))
        : { response: freeform.trim() }
    try {
      await runsApi.answerQuestion(question.runId, question.id, answers)
      onAnswered()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <form className="panel" onSubmit={submit} aria-label="待答复提问">
      {knownItems.length > 0 ? (
        knownItems.map((item) => (
          <div className="field" key={item.id}>
            <label className="field-label" htmlFor={`q-${question.id}-${item.id}`}>
              {item.text}
              {item.required ? <span aria-hidden="true">（必填）</span> : null}
            </label>
            {item.options && item.options.length > 0 ? (
              <select
                id={`q-${question.id}-${item.id}`}
                className="select"
                value={values[item.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [item.id]: e.target.value }))}
              >
                <option value="">请选择</option>
                {item.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                id={`q-${question.id}-${item.id}`}
                className="textarea"
                rows={2}
                value={values[item.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [item.id]: e.target.value }))}
              />
            )}
          </div>
        ))
      ) : (
        <>
          <div className="field">
            <label className="field-label" htmlFor={`q-${question.id}-freeform`}>
              实例请求输入
            </label>
            <textarea
              id={`q-${question.id}-freeform`}
              className="textarea"
              rows={2}
              value={freeform}
              onChange={(e) => setFreeform(e.target.value)}
            />
          </div>
          {question.raw !== undefined ? <JsonDetails data={question.raw} summary="查看问题原始数据" /> : null}
        </>
      )}
      {error ? <ErrorBox error={error} /> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {busy ? '正在提交…' : '提交答复'}
        </button>
      </div>
    </form>
  )
}
