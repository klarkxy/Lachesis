import { isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkspaceError } from './errors.ts'

const WIN_SEP = /\\/g

export function assertAbsolutePath(label: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceError('invalid_path', `${label} must be a non-empty path`)
  }
  if (value.includes('\0')) {
    throw new WorkspaceError('invalid_path', `${label} contains a NUL byte`)
  }
  if (!isAbsolute(value)) {
    throw new WorkspaceError('invalid_path', `${label} must be an absolute path: ${value}`)
  }
  return resolve(value)
}

export function assertSafeId(label: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..') || id.length > 128) {
    throw new WorkspaceError('invalid_id', `${label} must be a short opaque id of [A-Za-z0-9._-] without '..'`)
  }
  return id
}

export function toPosix(rel: string): string {
  return rel.replace(WIN_SEP, '/')
}

export function fromPosix(rel: string): string {
  return rel.split('/').join(sep)
}

export function assertRelativePosix(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceError('invalid_path', `${label} must be a relative path`)
  }
  if (value.includes('\0') || value.includes('\\')) {
    throw new WorkspaceError('invalid_path', `${label} must use posix separators without NUL`)
  }
  if (isAbsolute(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceError('invalid_path', `${label} must not be absolute`)
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new WorkspaceError('invalid_path', `${label} must not contain empty, '.', or '..' segments`)
  }
  return value
}

export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  if (base === target) return true
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function assertInside(root: string, candidate: string, label: string): string {
  const resolved = resolve(candidate)
  if (!isInside(root, resolved) && resolve(root) !== resolved) {
    throw new WorkspaceError('invalid_path', `${label} escapes ${root}`)
  }
  return resolved
}

export function safeJoin(root: string, posixRel: string): string {
  const rel = assertRelativePosix('path', posixRel)
  const joined = resolve(root, fromPosix(rel))
  return assertInside(root, joined, posixRel)
}

export function assertNoOverlap(storeRoot: string, projectRoot: string): void {
  if (storeRoot === projectRoot) {
    throw new WorkspaceError('invalid_path', 'storeRoot and projectRoot must be distinct directories')
  }
  if (isInside(projectRoot, storeRoot)) {
    throw new WorkspaceError('invalid_path', 'storeRoot must not live inside the project tree')
  }
}
