// Turns the image paths written in a document into URLs the window can load.
// The document keeps its original path, so nothing here touches the file.

let baseDir: string | null = null
let localImages = true

// Images beside a page aren't synced, so the browser has nothing to show.
export function disableLocalImages(): void {
  localImages = false
}

export function setAssetBase(dir: string | null): void {
  baseDir = dir
}

export function resolveAssetUrl(src: string | null | undefined): string | null {
  if (!src) return null
  if (/^(https?:|data:|folio-asset:)/i.test(src)) return src
  if (!localImages) return null
  if (!baseDir) return src

  const decoded = safeDecode(src).replace(/\\/g, '/')
  // A network path, which the main process refuses to open. See isNetworkPath.
  if (decoded.startsWith('//')) return null
  const isAbsolute = /^[a-z]:\//i.test(decoded) || decoded.startsWith('/')
  const absolute = isAbsolute ? decoded : `${baseDir.replace(/\\/g, '/')}/${decoded}`
  return `folio-asset://local/${encodeURIComponent(absolute)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
