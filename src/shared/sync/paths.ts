// Synced paths are relative, use forward slashes, and are compared the way Windows
// compares them, so "Notes.md" and "notes.md" can't become two files on a device.

import { PAGE_FILE } from '../fileTypes'

export const MAX_SYNC_BYTES = 4 * 1024 * 1024

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const FORBIDDEN = /[\\:*?"<>|\u0000-\u001f]/

export const pathKey = (path: string) => path.normalize('NFC').toLowerCase()

// Anything arriving from the network is checked with this before it touches a
// disk: only text files, and never a route out of the synced folder.
export function isSafePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false
  if (!PAGE_FILE.test(path) || FORBIDDEN.test(path) || path.startsWith('/')) return false
  return path.split('/').every((part) => {
    if (part === '' || part === '.' || part === '..') return false
    if (part.endsWith('.') || part.endsWith(' ') || part.startsWith('.')) return false
    return !RESERVED_NAME.test(part)
  })
}

export function conflictPath(path: string, device: string, date: Date, isTaken: (path: string) => boolean): string {
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = name.slice(0, dot)
  const extension = name.slice(dot)
  const stamp = date.toISOString().slice(0, 10)
  for (let attempt = 1; attempt < 1000; attempt++) {
    const suffix = attempt === 1 ? '' : ` ${attempt}`
    const candidate = `${folder}${stem} (conflict from ${device} ${stamp}${suffix})${extension}`
    if (!isTaken(candidate)) return candidate
  }
  throw new Error('Could not find a free file name.')
}
