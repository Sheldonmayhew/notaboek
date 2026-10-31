import { useEffect, useRef, useState } from 'react'

interface TitleProps {
  name: string
  autoFocus: boolean
  onFocused: () => void
  // Resolves to the name actually used, or null if the rename failed.
  onRename: (name: string) => Promise<string | null>
  onEnter: () => void
}

// The big title at the top of a page is the file's name.
export function PageTitle({ name, autoFocus, onFocused, onRename, onEnter }: TitleProps) {
  const [value, setValue] = useState(name)
  const field = useRef<HTMLTextAreaElement>(null)
  const confirmed = useRef(false)

  useEffect(() => setValue(name), [name])

  useEffect(() => {
    if (!autoFocus) return
    field.current?.focus()
    field.current?.select()
    onFocused()
  }, [autoFocus, onFocused])

  const commit = () => {
    const next = value.trim()
    if (next && next !== name) void onRename(next).then((final) => setValue(final ?? name))
    else setValue(name)
  }

  return (
    <textarea
      ref={field}
      className="page-title"
      rows={1}
      value={value}
      placeholder="Untitled"
      aria-label="Page title"
      spellCheck={false}
      onChange={(event) => setValue(event.target.value.replace(/\n/g, ''))}
      onBlur={() => {
        // Switching to another window isn't the same as finishing the name.
        if (confirmed.current || document.hasFocus()) commit()
        confirmed.current = false
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          confirmed.current = true
          event.currentTarget.blur()
          onEnter()
        }
      }}
    />
  )
}
