import type { FolioApi } from '../../shared/api'

declare global {
  interface Window {
    folio: FolioApi
  }
}

export const api = window.folio

// A drive root like C:\ has no last segment, so it stands for itself.
export const baseName = (path: string) =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

export const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, '')

export const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '')

export const extensionOf = (name: string) => /\.[^.]+$/.exec(name)?.[0] ?? ''

// Windows paths ignore case, and a link can spell a file's name either way.
export const samePath = (a: string | null | undefined, b: string | null | undefined) =>
  a?.toLowerCase() === b?.toLowerCase()

export function isInside(path: string, folder: string): boolean {
  const root = folder.replace(/[\\/]+$/, '').toLowerCase()
  const lower = path.toLowerCase()
  return lower.startsWith(`${root}\\`) || lower.startsWith(`${root}/`)
}

// The path below a folder, whether or not the folder ends in a separator.
export const relativeTo = (folder: string, path: string) =>
  path.slice(folder.length).replace(/^[\\/]+/, '')

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (/ENOENT/.test(message)) return "That file doesn't exist any more."
  if (/EPERM|EACCES/.test(message)) {
    return "Folio doesn't have permission to change this file. It may be read-only or open in another program."
  }
  if (/EBUSY/.test(message)) return 'Another program is using this file. Close it and try again.'
  if (/ENOSPC/.test(message)) return 'Your disk is full, so this file could not be saved.'
  return message
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

// Resolves a relative link against the folder of the current page.
export function resolveRelative(fromDir: string, href: string): string {
  const separator = fromDir.includes('\\') ? '\\' : '/'
  const parts = fromDir.split(/[\\/]/)
  for (const part of safeDecode(href).split(/[\\/]/)) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join(separator)
}
