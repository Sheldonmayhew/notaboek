import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { MAX_PAGE_MATCHES } from '../../../shared/search'

interface FindBarProps {
  query: string
  matchCase: boolean
  count: number
  index: number
  // Goes up each time find is asked for, so a second Ctrl+F comes back to the box.
  focusRequest: number
  onQuery: (query: string) => void
  onMatchCase: (matchCase: boolean) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}

export function FindBar(props: FindBarProps) {
  const { query, matchCase, count, index, focusRequest, onQuery, onMatchCase, onStep, onClose } = props
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusRequest])

  const total = count >= MAX_PAGE_MATCHES ? `${count.toLocaleString()}+` : count.toLocaleString()

  return (
    <div className="find-bar" role="search" aria-label="Find in page">
      <input
        ref={input}
        className="find-input"
        value={query}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count" role="status" data-empty={query !== '' && count === 0}>
        {query && (count === 0 ? 'No results' : `${(index + 1).toLocaleString()} of ${total}`)}
      </span>
      <button
        type="button"
        className="icon-button small"
        aria-label="Match case"
        aria-pressed={matchCase}
        data-active={matchCase}
        title="Match case"
        onClick={() => onMatchCase(!matchCase)}
      >
        <CaseSensitive size={16} />
      </button>
      <button
        type="button"
        className="icon-button small"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="icon-button small"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={count === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={16} />
      </button>
      <button type="button" className="icon-button small" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  )
}
