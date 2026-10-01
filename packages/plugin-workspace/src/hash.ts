import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { FileChange } from './types.ts'

const BINARY_WINDOW = 8000

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'))
}

export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_WINDOW)
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

export async function hashFile(path: string): Promise<{ sha256: string; size: number; binary: boolean }> {
  const hash = createHash('sha256')
  let size = 0
  let binary = false
  let inspected = 0
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    hash.update(buf)
    size += buf.length
    if (!binary && inspected < BINARY_WINDOW) {
      const n = Math.min(buf.length, BINARY_WINDOW - inspected)
      if (looksBinary(buf.subarray(0, n))) binary = true
      inspected += n
    }
  }
  return { sha256: hash.digest('hex'), size, binary }
}

export function manifestSha256(files: readonly FileChange[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const canonical = sorted.map((file) => ({
    path: file.path,
    kind: file.kind,
    size: file.size,
    sha256: file.sha256,
    binary: file.binary,
  }))
  return sha256Text(JSON.stringify(canonical))
}
