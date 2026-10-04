import type { AccessMode, AttendanceMode } from '@/api/types'
import { Field } from './ui'

export function lines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
}

export function PlanFields({ prefix, dependsOn, ownedPaths, readOnlyPaths, accessMode, attendance, isolationRequirement, onDependsOn, onOwnedPaths, onReadOnlyPaths, onAccessMode, onAttendance, onIsolationRequirement }: {
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
}) {
  return <>
    <Field label="依赖工单" htmlFor={`${prefix}-deps`} hint="每行一个同项目工单 ID；依赖必须先应用到目标工作区。">
      <textarea id={`${prefix}-deps`} className="textarea mono" rows={2} value={dependsOn} onChange={(event) => onDependsOn(event.target.value)} />
    </Field>
    <Field label="可修改路径" htmlFor={`${prefix}-owned`} hint="每行一个相对路径；目录以 / 结尾。留空表示不限制修改范围。">
      <textarea id={`${prefix}-owned`} className="textarea mono" rows={3} value={ownedPaths} onChange={(event) => onOwnedPaths(event.target.value)} />
    </Field>
    <Field label="只读路径" htmlFor={`${prefix}-readonly`} hint="每行一个相对路径；目录以 / 结尾。这里的路径始终不能被修改。">
      <textarea id={`${prefix}-readonly`} className="textarea mono" rows={2} value={readOnlyPaths} onChange={(event) => onReadOnlyPaths(event.target.value)} />
    </Field>
    {onAccessMode && accessMode !== undefined ? (
      <Field label="访问模式" htmlFor={`${prefix}-access`} hint="只读模式不能修改项目文件，仅可产生报告。">
        <select id={`${prefix}-access`} className="select" value={accessMode} onChange={(e) => onAccessMode(e.target.value as AccessMode)}>
          <option value="workspace-write">读写项目（可产生文件变更与交付）</option>
          <option value="read-only">只读项目（仅可产生报告，不能修改项目文件）</option>
        </select>
      </Field>
    ) : null}
    {onAttendance && attendance !== undefined ? (
      <Field label="执行模式" htmlFor={`${prefix}-attend`} hint="无人值守模式在权限范围内自动批准操作。">
        <select id={`${prefix}-attend`} className="select" value={attendance} onChange={(e) => onAttendance(e.target.value as AttendanceMode)}>
          <option value="manual">人工值守（操作需要审批）</option>
          <option value="bounded-unattended">有界无人值守（预授权范围内自动批准）</option>
        </select>
      </Field>
    ) : null}
    {onIsolationRequirement && isolationRequirement !== undefined ? (
      <Field label="隔离要求" htmlFor={`${prefix}-isolation`} hint="完整隔离要求后端支持；不足时阻塞派发。">
        <select id={`${prefix}-isolation`} className="select" value={isolationRequirement} onChange={(e) => onIsolationRequirement(e.target.value as 'trusted-host' | 'full')}>
          <option value="trusted-host">受信主机（默认）</option>
          <option value="full">完整隔离（需要后端支持）</option>
        </select>
      </Field>
    ) : null}
  </>
}
