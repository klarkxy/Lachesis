import { findPreset } from './avatars'

interface AvatarProps {
  presetId: string | null | undefined
  size?: number
  /** 可访问名称：通常是 Profile 名。 */
  label?: string
}

/** Profile 头像：同一 Profile 的所有实例渲染同一预设，绝不随机换脸。 */
export function Avatar({ presetId, size = 28, label }: AvatarProps) {
  const preset = findPreset(presetId)
  return (
    <span
      className="avatar"
      role="img"
      aria-label={label ? `${label}的头像（${preset.name}）` : `头像预设 ${preset.name}`}
      style={{ width: size, height: size }}
    >
      {preset.render()}
    </span>
  )
}
