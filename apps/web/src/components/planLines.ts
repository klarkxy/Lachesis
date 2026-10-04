export function lines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
}
