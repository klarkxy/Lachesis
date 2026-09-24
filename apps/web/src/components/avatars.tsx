/**
 * Lachesis 原创极简 Q 版头像预设。
 * 风格：大头近景、椭圆简化眼、少量腮红、平涂柔和阴影，
 * 通过发色 / 发型 / 发饰区分。全部为手工构造的原创 SVG，
 * 未复用施工包参考图素材。头像仅服务识别，不携带任何能力含义。
 */
import type { ReactElement } from 'react'

export interface AvatarPreset {
  id: string
  name: string
  render: () => ReactElement
}

const SKIN = '#f6d8c2'
const SKIN_SHADE = '#eec9ae'
const EYE = '#33261f'
const BLUSH = '#ee9e93'

interface HairSpec {
  color: string
  shade: string
  style: 'bob' | 'long' | 'buns' | 'ponytail' | 'short' | 'curly'
  accessory?: 'pin' | 'glasses' | 'ribbon'
}

function face(): ReactElement {
  return (
    <g key="face">
      <ellipse cx="32" cy="37" rx="15" ry="14" fill={SKIN} />
      <path d="M17 37a15 14 0 0 0 30 0z" fill={SKIN_SHADE} opacity="0.35" />
      <ellipse cx="26" cy="38" rx="2.1" ry="2.9" fill={EYE} />
      <ellipse cx="38" cy="38" rx="2.1" ry="2.9" fill={EYE} />
      <ellipse cx="22.5" cy="42.6" rx="2.6" ry="1.5" fill={BLUSH} opacity="0.55" />
      <ellipse cx="41.5" cy="42.6" rx="2.6" ry="1.5" fill={BLUSH} opacity="0.55" />
      <path d="M30 44.6q2 1.5 4 0" stroke="#b0705f" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </g>
  )
}

function hair(spec: HairSpec): ReactElement {
  const { color, shade, style } = spec
  const parts: ReactElement[] = []
  if (style === 'buns') {
    parts.push(<circle key="bl" cx="16.5" cy="16" r="6" fill={color} />)
    parts.push(<circle key="br" cx="47.5" cy="16" r="6" fill={color} />)
    parts.push(<circle key="bls" cx="18" cy="17.5" r="3.4" fill={shade} opacity="0.5" />)
    parts.push(<circle key="brs" cx="46" cy="17.5" r="3.4" fill={shade} opacity="0.5" />)
  }
  if (style === 'ponytail') {
    parts.push(<ellipse key="tail" cx="47" cy="32" rx="5.5" ry="12" fill={color} />)
    parts.push(<ellipse key="tails" cx="46" cy="35" rx="3" ry="8" fill={shade} opacity="0.5" />)
  }
  if (style === 'curly') {
    parts.push(<circle key="c1" cx="21" cy="19" r="5.5" fill={color} />)
    parts.push(<circle key="c2" cx="28" cy="14.5" r="6" fill={color} />)
    parts.push(<circle key="c3" cx="36" cy="14.5" r="6" fill={color} />)
    parts.push(<circle key="c4" cx="43" cy="19" r="5.5" fill={color} />)
    parts.push(<circle key="c5" cx="17.5" cy="27" r="4.5" fill={color} />)
    parts.push(<circle key="c6" cx="46.5" cy="27" r="4.5" fill={color} />)
  } else {
    const long = style === 'long'
    const side = long ? 46 : style === 'bob' ? 40 : 35
    parts.push(
      <path
        key="cap"
        d={`M16 ${side} C14 19 22 11 32 11 C42 11 50 19 48 ${side} L44.5 ${side} C45 30 44 24.5 41 22 C37.5 26.5 26.5 26.5 23 22 C20 24.5 19 30 19.5 ${side} Z`}
        fill={color}
      />,
    )
    parts.push(
      <path
        key="cap-shade"
        d="M23 22 C26.5 26.5 37.5 26.5 41 22 C40 20 38.5 19 32 19 C25.5 19 24 20 23 22 Z"
        fill={shade}
        opacity="0.45"
      />,
    )
  }
  if (spec.accessory === 'pin') {
    parts.push(
      <g key="pin" transform="rotate(24 40 20)">
        <rect x="36.5" y="18.2" width="7" height="2.4" rx="1.2" fill="#e8b64c" />
        <circle cx="42.6" cy="19.4" r="1.6" fill="#d94f4f" />
      </g>,
    )
  }
  if (spec.accessory === 'ribbon') {
    parts.push(
      <g key="ribbon" transform="translate(20 13)">
        <path d="M0 2 L-4.5 -1.5 L-4.5 5 Z" fill="#c2574e" />
        <path d="M0 2 L4.5 -1.5 L4.5 5 Z" fill="#c2574e" />
        <circle cx="0" cy="2" r="1.8" fill="#a03e37" />
      </g>,
    )
  }
  if (spec.accessory === 'glasses') {
    parts.push(
      <g key="glasses" fill="none" stroke="#4a4640" strokeWidth="1.4">
        <circle cx="26" cy="38" r="4.6" />
        <circle cx="38" cy="38" r="4.6" />
        <path d="M30.6 38h2.8M21.4 37.5L17.5 36M42.6 37.5l3.9-1.5" />
      </g>,
    )
  }
  return <g key="hair">{parts}</g>
}

function makePreset(id: string, name: string, spec: HairSpec): AvatarPreset {
  return {
    id,
    name,
    render: () => (
      <svg viewBox="0 0 64 64" role="img" aria-label={name} width="100%" height="100%">
        <circle cx="32" cy="32" r="32" fill="#eef3f1" />
        {face()}
        {hair(spec)}
      </svg>
    ),
  }
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  makePreset('chestnut-bob', '栗棕波波', { color: '#7a4a2e', shade: '#5f3820', style: 'bob' }),
  makePreset('linen-buns', '亚麻双丸', { color: '#d9b78a', shade: '#bd9a6b', style: 'buns' }),
  makePreset('ink-long', '墨黑长直', { color: '#33302e', shade: '#1e1c1a', style: 'long' }),
  makePreset('ash-short', '茶灰短发', { color: '#8d8578', shade: '#6f685c', style: 'short' }),
  makePreset('amber-pony', '暖棕马尾', { color: '#a05c33', shade: '#7d4523', style: 'ponytail' }),
  makePreset('indigo-glasses', '黛蓝眼镜', { color: '#3f4a63', shade: '#2c3549', style: 'bob', accessory: 'glasses' }),
  makePreset('tan-curly', '檀色卷发', { color: '#6b4f3a', shade: '#513a29', style: 'curly', accessory: 'pin' }),
  makePreset('honey-ribbon', '蜜茶缎带', { color: '#c99a5b', shade: '#a87c41', style: 'long', accessory: 'ribbon' }),
]

export const DEFAULT_AVATAR_ID = AVATAR_PRESETS[0]?.id ?? 'chestnut-bob'

export function findPreset(id: string | null | undefined): AvatarPreset {
  return AVATAR_PRESETS.find((p) => p.id === id) ?? AVATAR_PRESETS[0] as AvatarPreset
}
