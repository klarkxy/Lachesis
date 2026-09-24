/** Remove provider-emitted private reasoning tags from the user-facing reply. */
export function visibleAssistantReply(text: string): string {
  return text
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(think|analysis)\b[^>]*>[\s\S]*$/gi, '')
    .trim()
}
