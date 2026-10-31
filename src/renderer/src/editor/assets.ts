// Turns the image paths written in a document into URLs the window can load.
// The document keeps its original path, so nothing here touches the file.

let localImages = true

// Images beside a page aren't synced, so the browser has nothing to show.
export function disableLocalImages(): void {
  localImages = false
}

export function resolveAssetUrl(src: string | null | undefined, baseDir: string | null): string | null {
  if (!src) return null
  if (/^(https?:|data:|notaboek-asset:)/i.test(src)) return src
  if (!localImages) return null
  if (!baseDir) return src

  const decoded = safeDecode(src).replace(/\\/g, '/')
  // A network path, which the main process refuses to open. See isNetworkPath.
  if (decoded.startsWith('//')) return null
  const isAbsolute = /^[a-z]:\//i.test(decoded) || decoded.startsWith('/')
  const absolute = isAbsolute ? decoded : `${baseDir.replace(/\\/g, '/')}/${decoded}`
  return `notaboek-asset://local/${encodeURIComponent(absolute)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
