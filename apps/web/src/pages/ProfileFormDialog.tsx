import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { isConflict, profilesApi, type ProfileCapabilities } from '@/api/client'
import type { Profile } from '@/api/types'
import { Avatar } from '@/components/Avatar'
import { AVATAR_PRESETS, DEFAULT_AVATAR_ID } from '@/components/avatars'
import { Dialog } from '@/components/Dialog'
import { useToast } from '@/components/Toast'
import { ErrorBox, Field } from '@/components/ui'

/**
 * Profile 表单（新建 / 编辑 / 复制）。
 * 保存模型路由和明确的执行边界；
 * 名称与头像为展示元数据，不携带 persona、技能或岗位设定。
 */
function savedDshConfig(profile?: Profile): Record<string, unknown> {
  if (profile?.harnessId !== 'dsh-acp-0.1.7') return {}
  try {
    const value: unknown = JSON.parse(profile.configJson)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

export function ProfileFormDialog({
  open,
  onClose,
  mode,
  profile,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  /** create=新建；edit=编辑（带 expectedRevision）；copy=以现有配置为底稿新建 */
  mode: 'create' | 'edit' | 'copy'
  profile?: Profile
  onSaved: (profile: Profile) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [avatarPresetId, setAvatarPresetId] = useState(DEFAULT_AVATAR_ID)
  const [providerRef, setProviderRef] = useState('')
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState('')
  const [boundaryMode, setBoundaryMode] = useState<'whole-range' | 'native-tools'>('native-tools')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [capabilities, setCapabilities] = useState<ProfileCapabilities | null>(null)
  const [capabilityError, setCapabilityError] = useState<unknown>(null)
  const [checking, setChecking] = useState(false)
  const probeSerial = useRef(0)
  const id = useId()
  const formId = `${id}-form`

  useEffect(() => {
    probeSerial.current += 1
    if (open) {
      setName(mode === 'edit' ? (profile?.name ?? '') : mode === 'copy' ? `${profile?.name ?? ''} 副本` : '')
      setAvatarPresetId(profile?.avatarPresetId ?? DEFAULT_AVATAR_ID)
      setProviderRef(profile?.providerRef ?? '')
      setModelId(profile?.modelId ?? '')
      setEffort(profile?.reasoningEffort ?? '')
      setBoundaryMode(mode === 'create' || savedDshConfig(profile).boundaryMode === 'native-tools' ? 'native-tools' : 'whole-range')
      setError(null)
      setCapabilities(null)
      setCapabilityError(null)
      setChecking(false)
    }
  }, [open, mode, profile])

  const knownEffort = effort === '' || capabilities?.reasoningOptions.some((option) => option.value === effort) === true
  const valid = Boolean(name.trim() && providerRef.trim() && modelId.trim() && knownEffort &&
    (mode !== 'edit' || !profile || profile.harnessId === 'dsh-acp-0.1.7'))
  const title = mode === 'edit' ? '编辑执行配置' : mode === 'copy' ? '复制执行配置' : '新建执行配置'

  function changeRoute(field: 'provider' | 'model', value: string) {
    probeSerial.current += 1
    if (field === 'provider') setProviderRef(value)
    else setModelId(value)
    setEffort('')
    setCapabilities(null)
    setCapabilityError(null)
    setChecking(false)
  }

  async function checkCapabilities() {
    const provider = providerRef.trim()
    const model = modelId.trim()
    if (!provider || !model || checking) return
    const serial = ++probeSerial.current
    setChecking(true)
    setCapabilityError(null)
    try {
      const result = await profilesApi.capabilities(provider, model, boundaryMode)
      if (serial === probeSerial.current) setCapabilities(result)
    } catch (err) {
      if (serial === probeSerial.current) setCapabilityError(err)
    } finally {
      if (serial === probeSerial.current) setChecking(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      avatarPresetId,
      providerRef: providerRef.trim(),
      modelId: modelId.trim(),
      reasoningEffort: effort.trim() === '' ? null : effort.trim(),
      configJson: JSON.stringify({ ...savedDshConfig(profile), boundaryMode,
        providerRef: providerRef.trim(), modelId: modelId.trim(), reasoningEffort: effort.trim() || null }),
    }
    try {
      const saved =
        mode === 'edit' && profile
          ? await profilesApi.update(profile.id, body, profile.revision)
          : await profilesApi.create(body)
      toast.notify(mode === 'edit' ? '执行配置已保存' : '执行配置已创建')
      onSaved(saved)
    } catch (err) {
      if (isConflict(err)) {
        setError(new Error('这份执行配置已被别处修改。请关闭对话框，刷新后再试。'))
      } else {
        setError(err)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} busy={busy}>
      <form onSubmit={submit} id={formId}>
        <Field label="名称" htmlFor={`${id}-name`}>
          <input
            id={`${id}-name`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            placeholder="例如 白露"
          />
        </Field>
        <Field label="头像" hint="头像只用来辨认。同一份执行配置的每次执行都用这张头像，不代表能力不同。">
          <div className="avatar-picker" role="group" aria-label="选择头像预设">
            {AVATAR_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="avatar-option"
                aria-pressed={avatarPresetId === preset.id}
                onClick={() => setAvatarPresetId(preset.id)}
              >
                <Avatar presetId={preset.id} size={40} label={preset.name} />
                {preset.name}
              </button>
            ))}
          </div>
        </Field>
        <Field
          label="供应商引用"
          htmlFor={`${id}-provider`}
          hint="dsh ACP 中已配置的供应商标识；不在此填写凭据。"
        >
          <input
            id={`${id}-provider`}
            className="input mono"
            value={providerRef}
            onChange={(e) => changeRoute('provider', e.target.value)}
            required
            placeholder="例如 deepseek-official"
          />
        </Field>
        <Field label="模型" htmlFor={`${id}-model`}>
          <input
            id={`${id}-model`}
            className="input mono"
            value={modelId}
            onChange={(e) => changeRoute('model', e.target.value)}
            required
            placeholder="例如 deepseek-v4-flash"
          />
        </Field>
        <Field label="执行边界" htmlFor={`${id}-boundary`}
          hint={boundaryMode === 'native-tools'
            ? '本机运行时受信任，文件与终端工具使用原生沙箱；配置和临时文件保持私有。Windows 暂不支持只读或完整隔离。'
            : '限制整个执行进程；当前 Windows 原生终端工具与此模式不兼容。'}>
          <select id={`${id}-boundary`} className="input" value={boundaryMode} disabled={busy}
            onChange={(e) => {
              setBoundaryMode(e.target.value as 'whole-range' | 'native-tools')
              probeSerial.current += 1
              setCapabilities(null)
              setCapabilityError(null)
              setChecking(false)
              setEffort('')
            }}>
            <option value="native-tools">原生工具隔离</option>
            <option value="whole-range">整进程隔离</option>
          </select>
        </Field>
        <Field
          label="思考强度"
          htmlFor={`${id}-effort`}
          hint="默认使用供应商设置。检查模型能力后，可选择它实际支持的强度。"
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              id={`${id}-effort`}
              className="input mono"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              disabled={!capabilities || capabilities.reasoningOptions.length === 0 || checking || busy}
              style={{ flex: 1 }}
            >
              <option value="">供应商默认</option>
              {effort && !capabilities?.reasoningOptions.some((option) => option.value === effort) ? (
                <option value={effort} disabled>原设置：{effort}（待核对）</option>
              ) : null}
              {capabilities?.reasoningOptions.filter((option) => option.value !== '').map((option) => (
                <option key={option.value} value={option.value}>{option.name}</option>
              ))}
            </select>
            <button type="button" className="btn" onClick={checkCapabilities}
              disabled={!providerRef.trim() || !modelId.trim() || checking || busy}>
              {checking ? '检查中…' : '检查可用强度'}
            </button>
          </div>
          <p className="muted small" role="status" style={{ margin: '6px 0 0' }}>
            {capabilities && capabilities.reasoningOptions.length === 0
              ? '此模型未提供可调整的强度，将使用供应商默认。'
              : capabilities ? '已读取此模型支持的强度。' : null}
            {effort && !knownEffort ? ' 当前强度尚未确认可用，请检查或改用供应商默认。' : null}
          </p>
          {effort && !knownEffort ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEffort('')}>
              改用供应商默认
            </button>
          ) : null}
        </Field>
        {capabilityError ? <ErrorBox error={capabilityError} /> : null}
        {error ? <ErrorBox error={error} /> : null}
      </form>
      <div className="dialog-foot" style={{ margin: '0 -18px -16px', paddingTop: 12 }}>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!valid || busy}>
          {busy ? '正在保存…' : mode === 'edit' ? '保存修改' : '创建执行配置'}
        </button>
      </div>
    </Dialog>
  )
}
