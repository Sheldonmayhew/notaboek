import { computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom'
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  anchor: { getBoundingClientRect: () => DOMRect }
  placement?: Placement
  onClose: () => void
  // Off for menus acting on the editor's selection, which taking focus would hide.
  takeFocus?: boolean
  returnFocus?: boolean
  className?: string
  children: ReactNode
}

const menuItems = (menu: HTMLElement) => [
  ...menu.querySelectorAll<HTMLElement>('button:not(:disabled)')
]

export function Popover({
  anchor,
  placement = 'bottom-start',
  onClose,
  takeFocus = true,
  returnFocus = true,
  className,
  children
}: PopoverProps) {
  const element = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const popover = element.current
    if (!popover) return
    opener.current = document.activeElement as HTMLElement | null
    void computePosition(anchor, popover, {
      placement,
      strategy: 'fixed',
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })]
    }).then(({ x, y }) => {
      popover.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
      popover.style.visibility = 'visible'
      // Hidden elements can't take focus, so this has to wait for the position.
      if (takeFocus) menuItems(popover)[0]?.focus({ preventScroll: true })
    })
    return () => {
      if (takeFocus && returnFocus && opener.current?.isConnected) opener.current.focus()
    }
  }, [anchor, placement, takeFocus, returnFocus])

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (element.current?.contains(target)) return
      // The button that opened this menu closes it with its own click.
      if (anchor instanceof Node && anchor.contains(target)) return
      onClose()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [anchor, onClose])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(event.currentTarget)
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const steps: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      Tab: current + (event.shiftKey ? -1 : 1),
      Home: 0,
      End: items.length - 1
    }
    const next = steps[event.key]
    if (next === undefined) return
    event.preventDefault()
    items[(next + items.length) % items.length].focus()
  }

  return createPortal(
    <div
      ref={element}
      className={`menu popover ${className ?? ''}`}
      style={{ visibility: 'hidden' }}
      onKeyDown={moveFocus}
    >
      {children}
    </div>,
    document.body
  )
}
