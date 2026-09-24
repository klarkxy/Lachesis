import { Field } from './ui'

export function lines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
}

export function PlanFields({ prefix, dependsOn, ownedPaths, readOnlyPaths, onDependsOn, onOwnedPaths, onReadOnlyPaths }: {
  prefix: string
  dependsOn: string
  ownedPaths: string
  readOnlyPaths: string
  onDependsOn: (value: string) => void
  onOwnedPaths: (value: string) => void
  onReadOnlyPaths: (value: string) => void
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
  </>
}
