import { createHash, randomUUID } from 'node:crypto'
import type { SQLOutputValue } from 'node:sqlite'

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortValue)
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortValue(record[key])
  }
  return sorted
}

export function asText(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected text column')
  return value
}

export function asTextOrNull(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('expected text-or-null column')
  return value
}

export function asInt(value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('expected integer column')
  return value
}

export function asIntOrNull(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined) return null
  return asInt(value)
}

export function parseJson<T>(value: SQLOutputValue | undefined): T {
  return JSON.parse(asText(value)) as T
}

export function parseCursor(cursor: string): { createdAt: string; id: string } {
  const sep = cursor.indexOf('|')
  if (sep <= 0) throw new Error('invalid cursor')
  return { createdAt: cursor.slice(0, sep), id: cursor.slice(sep + 1) }
}

export function makeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`
}

export function parseAfter(after: number | string | null | undefined): number {
  if (after === null || after === undefined || after === '') return 0
  const n = typeof after === 'number' ? after : Number(after)
  if (!Number.isFinite(n) || n < 0) throw new Error('invalid after cursor')
  return n
}
