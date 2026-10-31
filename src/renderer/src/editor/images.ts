import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { api, baseName, friendlyError, stripExtension } from '../platform'

const EXTENSION_OF: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
}

interface ImageStorage {
  // The folder of the page, where images go and what their paths are relative to.
  dir: string
  allowed: boolean
  onError: (message: string) => void
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageImages: {
      pickImage: () => ReturnType
    }
  }
}

const storageOf = (editor: Editor) => (editor.storage as unknown as { pageImages: ImageStorage }).pageImages

export const canInsertImages = (editor: Editor) => storageOf(editor).allowed

export function setImageFolder(editor: Editor, dir: string): void {
  storageOf(editor).dir = dir
}

const imageFiles = (files: FileList | undefined) => [...(files ?? [])].filter((file) => file.type in EXTENSION_OF)

function insertImages(editor: Editor, images: Array<{ src: string; alt: string | null }>, position?: number): void {
  if (images.length === 0 || editor.isDestroyed) return
  const content = images.map((attrs) => ({ type: 'image', attrs }))
  const { doc, selection } = editor.state
  const $at = doc.resolve(Math.min(position ?? selection.from, doc.content.size))
  // A code block can only hold text, so the image goes straight after it.
  const inCode = $at.parent.type.spec.code === true
  const replacing = position === undefined && !selection.empty && !inCode
  const target = replacing ? { from: selection.from, to: selection.to } : inCode ? $at.after() : $at.pos
  editor.chain().insertContentAt(target, content).focus().run()
}

function saveFiles(editor: Editor, files: File[], position?: number, pasted = false): void {
  const { dir, onError } = storageOf(editor)
  const save = async (file: File) => {
    // Screenshots all arrive as "image.png", which says nothing and would pile up.
    const stamp = new Date().toLocaleString('sv').replace(/:/g, '')
    const name = pasted ? `Pasted image ${stamp}.${EXTENSION_OF[file.type]}` : file.name
    const src = await api.saveImage(dir, name, new Uint8Array(await file.arrayBuffer()))
    return { src, alt: pasted ? null : stripExtension(file.name) }
  }
  Promise.all(files.map(save)).then(
    (images) => insertImages(editor, images, position),
    (error: unknown) => onError(friendlyError(error))
  )
}

export const PageImages = Extension.create<ImageStorage, ImageStorage>({
  name: 'pageImages',

  addOptions() {
    return { dir: '', allowed: false, onError: () => undefined }
  },

  addStorage() {
    return { ...this.options }
  },

  addCommands() {
    return {
      pickImage:
        () =>
        ({ editor }) => {
          const { dir, onError } = storageOf(editor)
          api.pickImages(dir).then(
            (found) =>
              insertImages(
                editor,
                found.map((src) => ({ src, alt: stripExtension(baseName(src)) }))
              ),
            (error: unknown) => onError(friendlyError(error))
          )
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    return [
      new Plugin({
        key: new PluginKey('pageImages'),
        props: {
          handlePaste(_view, event) {
            const files = imageFiles(event.clipboardData?.files)
            // Spreadsheets put a picture of the cells on the clipboard beside the text.
            if (!canInsertImages(editor) || files.length === 0 || event.clipboardData?.getData('text/plain')) {
              return false
            }
            saveFiles(editor, files, undefined, true)
            return true
          },
          handleDrop(view, event, _slice, moved) {
            const files = imageFiles(event.dataTransfer?.files)
            if (moved || !canInsertImages(editor) || files.length === 0) return false
            event.preventDefault()
            saveFiles(editor, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
            return true
          }
        }
      })
    ]
  }
})
