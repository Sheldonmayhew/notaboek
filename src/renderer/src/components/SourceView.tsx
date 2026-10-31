import { useLayoutEffect, type ReactNode, type RefObject } from 'react'
import type { TextRange } from '../../../shared/api'

interface SourceViewProps {
  value: string
  field: RefObject<HTMLTextAreaElement | null>
  matches: TextRange[]
  index: number
  onChange: (text: string) => void
}

const growsByItself = CSS.supports('field-sizing', 'content')

// A textarea can't colour parts of its text, so matches are drawn on a copy of
// it underneath. The copy has to wrap exactly the same way to line up.
function highlighted(value: string, matches: TextRange[], index: number): ReactNode[] {
  const parts: ReactNode[] = []
  let shown = 0
  matches.forEach(({ start, end }, position) => {
    parts.push(
      value.slice(shown, start),
      <mark key={start} className={position === index ? 'find-match find-current' : 'find-match'}>
        {value.slice(start, end)}
      </mark>
    )
    shown = end
  })
  parts.push(value.slice(shown))
  return parts
}

export function SourceView({ value, field, matches, index, onChange }: SourceViewProps) {
  useLayoutEffect(() => {
    const box = field.current
    if (growsByItself || !box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }, [field, value])

  return (
    <div className="source-frame">
      {matches.length > 0 && (
        <div className="source-marks" aria-hidden="true">
          {highlighted(value, matches, index)}
        </div>
      )}
      <textarea
        ref={field}
        className="source-view"
        value={value}
        spellCheck={false}
        aria-label="File source"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
