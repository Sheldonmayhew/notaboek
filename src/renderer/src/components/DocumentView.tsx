import type { Editor } from '@tiptap/react'
import { lazy, Suspense, type RefObject } from 'react'
import type { DocumentWriter } from '../doc/documentSession'
import type { OpenDocument, PageHandle } from '../tabs'

// pdf.js and the Word reader are large, so they load the first time one is opened.
const PdfView = lazy(() => import('../documents/PdfView'))
const DocxView = lazy(() => import('../documents/DocxView'))

interface DocumentViewProps {
  document: OpenDocument
  active: boolean
  view: RefObject<PageHandle | null>
  onWriter: (writer: DocumentWriter) => void
  onEditor: (editor: Editor) => void
  onEdit: () => void
  onError: (message: string) => void
}

export function DocumentView({ document, active, view, onWriter, onEditor, onEdit, onError }: DocumentViewProps) {
  return (
    <div className="tab-view" hidden={!active}>
      <Suspense fallback={<div className="empty-state">Opening…</div>}>
        {document.kind === 'pdf' ? (
          <PdfView snapshot={document.snapshot} active={active} view={view} onWriter={onWriter} onEdit={onEdit} />
        ) : (
          <DocxView
            snapshot={document.snapshot}
            active={active}
            view={view}
            onWriter={onWriter}
            onEditor={onEditor}
            onEdit={onEdit}
            onError={onError}
          />
        )}
      </Suspense>
    </div>
  )
}
