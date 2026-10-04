import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function safeHref(href: string | undefined): string | null {
  if (!href) return null
  const value = href.trim()
  if (/^https?:\/\//i.test(value) || href.startsWith('/') || href.startsWith('#')) return value
  if (/^mailto:/i.test(value) && !/javascript:/i.test(value)) return value
  return null
}

const components: Components = {
  h1: 'h2',
  h2: 'h3',
  h3: 'h4',
  h4: 'h5',
  h5: 'h6',
  h6: 'h6',
  img({ alt, src }) {
    const where = typeof src === 'string' && src ? src : ''
    return (
      <span className="md-skipped">
        图片未自动加载{alt ? `（${alt}）` : ''}
        {where ? `：${where}` : ''}
      </span>
    )
  },
  a({ href, children }) {
    const safe = safeHref(href)
    if (!safe) return <span>{children}</span>
    const external = /^https?:/i.test(safe)
    return (
      <a href={safe} rel={external ? 'noreferrer noopener' : undefined} target={external ? '_blank' : undefined}>
        {children}
      </a>
    )
  },
}

/** 冻结交付里的 Markdown。不执行原始 HTML，也不请求远程图片。 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
