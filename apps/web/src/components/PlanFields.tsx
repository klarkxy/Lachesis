import { useState } from 'react'
import type { AccessMode, AttendanceMode } from '@/api/types'
import { Field } from './ui'
import { lines } from './planLines'

export { lines } from './planLines'

export function PlanFields({
  prefix,
  dependsOn,
  ownedPaths,
  readOnlyPaths,
  accessMode,
  attendance,
  isolationRequirement,
  onDependsOn,
  onOwnedPaths,
  onReadOnlyPaths,
  onAccessMode,
  onAttendance,
  onIsolationRequirement,
  projectTasks,
  tasksLoading = false,
  tasksFailed = false,
  excludeTaskId,
  advancedInitiallyOpen = false,
}: {
  prefix: string
  dependsOn: string
  ownedPaths: string
  readOnlyPaths: string
  accessMode?: AccessMode
  attendance?: AttendanceMode
  isolationRequirement?: 'trusted-host' | 'full'
  onDependsOn: (value: string) => void
  onOwnedPaths: (value: string) => void
  onReadOnlyPaths: (value: string) => void
  onAccessMode?: (value: AccessMode) => void
  onAttendance?: (value: AttendanceMode) => void
  onIsolationRequirement?: (value: 'trusted-host' | 'full') => void
  projectTasks?: { id: string; title: string }[]
  tasksLoading?: boolean
  tasksFailed?: boolean
  excludeTaskId?: string
  advancedInitiallyOpen?: boolean
}) {
  const [advancedOpen, setAdvancedOpen] = useState(advancedInitiallyOpen)
  const selected = new Set(lines(dependsOn))
  const choices = (projectTasks ?? []).filter((task) => task.id !== excludeTaskId)
  const known = new Set(choices.map((task) => task.id))
  const extras = lines(dependsOn).filter((id) => !known.has(id))

  function toggle(id: string) {
    const current = lines(dependsOn)
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    onDependsOn(next.join('\n'))
  }

  return (
    <>
      <Field label="依赖任务" htmlFor={projectTasks ? undefined : `${prefix}-deps`} hint="被选中的任务必须先验收并写入目标项目，这一张才会开始。">
        {projectTasks ? (
          <div className="task-pick" role="group" aria-label="选择依赖任务">
            {tasksLoading ? <p className="muted small" style={{ padding: '8px 10px' }}>正在读取本项目的任务…</p> : null}
            {tasksFailed ? (
              <p className="muted small" style={{ padding: '8px 10px' }}>
                暂时读不到任务列表。可以在下面的高级项里按编号填写。
              </p>
            ) : null}
            {!tasksLoading && !tasksFailed && choices.length === 0 && extras.length === 0 ? (
              <p className="muted small" style={{ padding: '8px 10px' }}>本项目还没有其他任务可选。</p>
            ) : null}
            {choices.map((task) => (
              <label key={task.id} className="task-pick-item">
                <input type="checkbox" checked={selected.has(task.id)} onChange={() => toggle(task.id)} />
                <span>{task.title}</span>
              </label>
            ))}
            {extras.map((id) => (
              <label key={id} className="task-pick-item">
                <input type="checkbox" checked onChange={() => toggle(id)} />
                <span className="mono">{id}</span>
              </label>
            ))}
          </div>
        ) : (
          <textarea
            id={`${prefix}-deps`}
            className="textarea mono"
            rows={2}
            value={dependsOn}
            onChange={(event) => onDependsOn(event.target.value)}
          />
        )}
      </Field>
      <details className="fold" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>路径、访问、值守和隔离</summary>
        {projectTasks ? (
          <Field label="直接填写任务编号" htmlFor={`${prefix}-deps`} hint="每行一个编号。上面的标题选择会和这里保持一致。">
            <textarea
              id={`${prefix}-deps`}
              className="textarea mono"
              rows={2}
              value={dependsOn}
              onChange={(event) => onDependsOn(event.target.value)}
            />
          </Field>
        ) : null}
        <Field label="可修改路径" htmlFor={`${prefix}-owned`} hint="每行一个相对路径；目录以 / 结尾。留空表示不限制修改范围。">
          <textarea id={`${prefix}-owned`} className="textarea mono" rows={3} value={ownedPaths} onChange={(event) => onOwnedPaths(event.target.value)} />
        </Field>
        <Field label="只读路径" htmlFor={`${prefix}-readonly`} hint="每行一个相对路径；目录以 / 结尾。这里的路径始终不能被修改。">
          <textarea id={`${prefix}-readonly`} className="textarea mono" rows={2} value={readOnlyPaths} onChange={(event) => onReadOnlyPaths(event.target.value)} />
        </Field>
        {onAccessMode && accessMode !== undefined ? (
          <Field label="访问模式" htmlFor={`${prefix}-access`} hint="只读模式不能修改项目文件，只产生报告。验收后可以不写入项目。">
            <select id={`${prefix}-access`} className="select" value={accessMode} onChange={(e) => onAccessMode(e.target.value as AccessMode)}>
              <option value="workspace-write">读写项目（可以产生文件变更）</option>
              <option value="read-only">只读项目（只产生报告，不修改项目文件）</option>
            </select>
          </Field>
        ) : null}
        {onAttendance && attendance !== undefined ? (
          <Field label="值守方式" htmlFor={`${prefix}-attend`} hint="无人值守会在预先允许的范围内自动批准操作。">
            <select id={`${prefix}-attend`} className="select" value={attendance} onChange={(e) => onAttendance(e.target.value as AttendanceMode)}>
              <option value="manual">人工值守（操作需要人批准）</option>
              <option value="bounded-unattended">有界无人值守（允许范围内自动批准）</option>
            </select>
          </Field>
        ) : null}
        {onIsolationRequirement && isolationRequirement !== undefined ? (
          <Field label="隔离要求" htmlFor={`${prefix}-isolation`} hint="完整隔离需要后端支持；不满足时这张任务不会开始。">
            <select id={`${prefix}-isolation`} className="select" value={isolationRequirement} onChange={(e) => onIsolationRequirement(e.target.value as 'trusted-host' | 'full')}>
              <option value="trusted-host">受信主机（默认）</option>
              <option value="full">完整隔离（需要后端支持）</option>
            </select>
          </Field>
        ) : null}
      </details>
    </>
  )
}
