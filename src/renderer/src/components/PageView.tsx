import type { Editor } from '@tiptap/react'
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { findInText } from '../../../shared/search'
import { positionOfLine, offsetOfLine, serializeDocument } from '../doc/document'
import { endFind, findStatus, goToMatchFrom, searchInPage, stepMatch } from '../editor/FindInPage'
import { focusNow } from '../editor/focus'
import { PageEditor } from '../editor/PageEditor'
import { baseName, dirName, extensionOf, stripExtension } from '../platform'
import type { OpenPage, PageHandle, Tab } from '../tabs'
import { FindBar } from './FindBar'
import { PageTitle } from './PageHeader'
import { SourceView } from './SourceView'

interface FindRequest {
  query: string
  matchCase: boolean
  // Which match is current in source view. The editor keeps its own.
  sourceIndex: number
  focusRequest: number
}

interface PageViewProps {
  tab: Tab
  page: OpenPage
  path: string
  active: boolean
  view: RefObject<PageHandle | null>
  onReady: (editor: Editor, text: () => string) => void
  onChange: (editor: Editor) => void
  onSourceChange: (text: string) => void
  onOpenLink: (href: string) => void
  onFocused: () => void
  onRevealed: () => void
  onRename: (name: string) => Promise<string | null>
  onImageError: (message: string) => void
}

export function PageView(props: PageViewProps) {
  const { tab, page, path, active, view, onReady, onChange, onSourceChange, onOpenLink, onFocused, onRevealed } = props
  const { sourceText, hasTitleBlock } = tab
  const inSource = sourceText !== null
  const [editor, setEditor] = useState<Editor | null>(null)
  const [find, setFind] = useState<FindRequest | null>(null)
  const [found, setFound] = useState({ count: 0, index: -1 })
  const scroller = useRef<HTMLDivElement>(null)
  const sourceField = useRef<HTMLTextAreaElement>(null)
  const scrolled = useRef(0)

  const fileName = baseName(path)
  const showTitle = !hasTitleBlock && !inSource
  const query = find?.query ?? ''
  const matchCase = find?.matchCase ?? false

  const sourceMatches = useMemo(
    () => (inSource ? findInText(sourceText, query, { matchCase }) : []),
    [inSource, sourceText, query, matchCase]
  )
  const count = inSource ? sourceMatches.length : found.count
  const index = inSource ? Math.min(find?.sourceIndex ?? 0, sourceMatches.length - 1) : found.index

  // A hidden element can't be relied on to keep its scroll position. Setting this
  // lays the whole page out on the spot, so a page at the top is left alone.
  useLayoutEffect(() => {
    if (active && scrolled.current > 0 && scroller.current) scroller.current.scrollTop = scrolled.current
  }, [active])

  useEffect(() => {
    if (!editor || inSource) return
    const sync = () =>
      setFound((shown) => {
        const next = findStatus(editor)
        return shown.count === next.count && shown.index === next.index ? shown : next
      })
    editor.on('transaction', sync)
    return () => void editor.off('transaction', sync)
  }, [editor, inSource])

  useEffect(() => {
    if (editor && !inSource && !editor.isDestroyed) searchInPage(editor, query, { matchCase })
  }, [editor, inSource, query, matchCase])

  // Someone editing the page while the bar is open shouldn't be scrolled away.
  useEffect(() => {
    if (!find || editor?.isFocused || document.activeElement === sourceField.current) return
    const match = scroller.current?.querySelector('.find-current')
    const show = () => match?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    show()
    // On a large page that may have reached blocks not drawn yet, whose real
    // size moves things a little once they are.
    requestAnimationFrame(() => requestAnimationFrame(show))
  }, [find, editor, index, count])

  const { reveal } = page
  useEffect(() => {
    if (!reveal || (!editor && !inSource)) return
    const { query: text, matchCase: exact, line } = reveal
    let sourceIndex = 0
    if (inSource) {
      const offset = offsetOfLine(sourceText, line)
      const matches = findInText(sourceText, text, { matchCase: exact })
      sourceIndex = Math.max(0, matches.findIndex((match) => match.start >= offset))
    } else if (editor) {
      searchInPage(editor, text, { matchCase: exact })
      goToMatchFrom(editor, positionOfLine(page.loaded, line))
    }
    setFind((shown) => ({
      query: text,
      matchCase: exact,
      sourceIndex,
      focusRequest: (shown?.focusRequest ?? 0) + 1
    }))
    onRevealed()
  }, [reveal, editor, inSource, sourceText, page.loaded, onRevealed])

  const selectedText = () => {
    if (inSource) {
      const box = sourceField.current
      return box ? box.value.slice(box.selectionStart, box.selectionEnd) : ''
    }
    if (!editor) return ''
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, '\n')
  }

  const openFind = () => {
    const selected = selectedText()
    const chosen = selected && !selected.includes('\n') ? selected : null
    setFind((shown) => ({
      query: chosen ?? shown?.query ?? '',
      matchCase: shown?.matchCase ?? false,
      sourceIndex: 0,
      focusRequest: (shown?.focusRequest ?? 0) + 1
    }))
  }

  const stepFind = (direction: 1 | -1) => {
    if (!find) return
    if (!inSource) {
      if (editor) stepMatch(editor, direction)
      return
    }
    const total = sourceMatches.length
    if (total === 0) return
    setFind({ ...find, sourceIndex: (index + direction + total) % total })
  }

  const focusPage = () => {
    if (inSource) sourceField.current?.focus()
    else editor?.view.focus()
  }

  const closeFind = () => {
    const match = sourceMatches[index]
    setFind(null)
    if (inSource) {
      sourceField.current?.focus()
      if (match) sourceField.current?.setSelectionRange(match.start, match.end)
    } else if (editor) {
      endFind(editor)
      editor.view.focus()
    }
  }

  useImperativeHandle(view, () => ({ openFind, stepFind, focus: focusPage }))

  return (
    <div
      className="tab-view"
      hidden={!active}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && find && !event.defaultPrevented) closeFind()
      }}
    >
      {find && (
        <FindBar
          query={query}
          matchCase={matchCase}
          count={count}
          index={index}
          focusRequest={find.focusRequest}
          onQuery={(next) => setFind({ ...find, query: next, sourceIndex: 0 })}
          onMatchCase={(next) => setFind({ ...find, matchCase: next, sourceIndex: 0 })}
          onStep={stepFind}
          onClose={closeFind}
        />
      )}

      <div
        className="scroller"
        ref={scroller}
        onScroll={(event) => {
          if (active) scrolled.current = event.currentTarget.scrollTop
        }}
      >
        <div className="page">
          {showTitle && (
            <PageTitle
              name={stripExtension(fileName)}
              autoFocus={page.focus === 'title'}
              onFocused={onFocused}
              onRename={(name) => props.onRename(`${name}${extensionOf(fileName)}`)}
              onEnter={() => editor && focusNow(editor, 'start')}
            />
          )}

          {sourceText === null ? (
            <PageEditor
              loaded={page.loaded}
              scroller={scroller}
              autoFocus={page.focus === 'body'}
              active={active}
              assetDir={dirName(path)}
              onReady={(instance) => {
                setEditor(instance)
                onReady(instance, () => serializeDocument(instance.state.doc, page.loaded))
              }}
              onChange={onChange}
              onOpenLink={onOpenLink}
              onImageError={props.onImageError}
            />
          ) : (
            <SourceView
              value={sourceText}
              field={sourceField}
              matches={sourceMatches}
              index={index}
              onChange={onSourceChange}
            />
          )}

          <div
            className="page-end"
            onClick={() => {
              if (editor && !inSource) focusNow(editor, 'end')
            }}
          />
        </div>
      </div>
    </div>
  )
}
