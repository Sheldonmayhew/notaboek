import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { SearchLine, SearchResults as Results } from '../../../shared/api'
import { api, baseName, friendlyError, pageIcon, relativeTo, stripExtension } from '../platform'

const SEARCH_DELAY = 180

interface SearchResultsProps {
  workspace: string
  query: string
  matchCase: boolean
  // Goes up when files change, so results don't go stale.
  version: number
  onOpen: (path: string, line: number | null, newTab: boolean) => void
}

function Highlighted({ line }: { line: SearchLine }) {
  return (
    <>
      {line.text.slice(0, line.start)}
      <mark className="find-match">{line.text.slice(line.start, line.end)}</mark>
      {line.text.slice(line.end)}
    </>
  )
}

const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (step === 0) return
  event.preventDefault()
  const list = event.currentTarget
  const rows = [...list.querySelectorAll<HTMLElement>('button')]
  rows[rows.indexOf(document.activeElement as HTMLElement) + step]?.focus()
}

export function SearchResults({ workspace, query, matchCase, version, onOpen }: SearchResultsProps) {
  const [results, setResults] = useState<Results | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const request = useRef(0)

  useEffect(() => {
    const current = ++request.current
    const timer = setTimeout(() => {
      api.searchFiles(query, { matchCase }).then(
        (found) => {
          if (current !== request.current) return
          setResults(found)
          setProblem(null)
        },
        (error: unknown) => {
          if (current === request.current) setProblem(friendlyError(error))
        }
      )
    }, SEARCH_DELAY)
    return () => clearTimeout(timer)
  }, [query, matchCase, version])

  // A page named after the search is usually the one being looked for.
  const hits = [...(results?.hits ?? [])].sort((a, b) => Number(b.nameMatches) - Number(a.nameMatches))
  const open = (path: string, line: number | null, event: MouseEvent) => {
    if (event.button === 0 || event.button === 1) onOpen(path, line, event.button === 1)
  }
  const summary =
    problem ??
    (!results
      ? 'Searching…'
      : hits.length === 0
        ? 'No results'
        : results.truncated
          ? `Showing the first ${hits.length} pages`
          : `${hits.length} ${hits.length === 1 ? 'page' : 'pages'}`)

  return (
    <div className="search-results" role="list" aria-label="Search results" onKeyDown={moveFocus}>
      <div className="search-status" role="status">
        {summary}
      </div>
      {hits.map((hit) => {
        const Icon = pageIcon(hit.path)
        const folder = relativeTo(workspace, hit.path).split(/[\\/]/).slice(0, -1).join(' / ')
        const hidden = hit.total - hit.lines.length
        return (
          <div key={hit.path} className="search-hit" role="listitem">
            <button
              type="button"
              className="search-page"
              title={hit.path}
              onClick={(event) => open(hit.path, hit.lines[0]?.line ?? null, event)}
              onAuxClick={(event) => open(hit.path, hit.lines[0]?.line ?? null, event)}
            >
              <Icon size={16} strokeWidth={1.6} className="tree-icon" />
              <span className="search-name">{stripExtension(baseName(hit.path))}</span>
              {folder && <span className="search-folder">{folder}</span>}
              {hit.total > 0 && <span className="search-total">{hit.total.toLocaleString()}</span>}
            </button>
            {hit.lines.map((line) => (
              <button
                key={line.line}
                type="button"
                className="search-line"
                onClick={(event) => open(hit.path, line.line, event)}
                onAuxClick={(event) => open(hit.path, line.line, event)}
              >
                <Highlighted line={line} />
              </button>
            ))}
            {hidden > 0 && <div className="search-more">and {hidden.toLocaleString()} more on this page</div>}
          </div>
        )
      })}
    </div>
  )
}
