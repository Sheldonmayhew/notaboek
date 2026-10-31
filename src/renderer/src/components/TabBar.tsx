import { File, FileText, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { baseName, stripExtension } from '../platform'
import type { Tab } from '../tabs'
import { Popover } from './Popover'

interface TabBarProps {
  tabs: Tab[]
  activeId: number | null
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onCloseOthers: (id: number) => void
  onNew: () => void
  onReorder: (id: number, before: number) => void
}

interface TabMenu {
  id: number
  anchor: { getBoundingClientRect: () => DOMRect }
}

const titleOf = (tab: Tab) => (tab.path ? stripExtension(baseName(tab.path)) : 'New tab')

export function TabBar({ tabs, activeId, onSelect, onClose, onCloseOthers, onNew, onReorder }: TabBarProps) {
  const [menu, setMenu] = useState<TabMenu | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const openMenu = (id: number, event: MouseEvent) => {
    event.preventDefault()
    const rect = new DOMRect(event.clientX, event.clientY, 0, 0)
    setMenu({ id, anchor: { getBoundingClientRect: () => rect } })
  }

  const startDrag = (id: number, event: DragEvent) => {
    dragging.current = id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-notaboek-tab', String(id))
  }

  const dragOver = (id: number, event: DragEvent) => {
    const moving = dragging.current
    if (moving === null) return
    event.preventDefault()
    if (moving !== id) onReorder(moving, id)
  }

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    const rows = [...(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    rows[(rows.indexOf(event.currentTarget) + step + rows.length) % rows.length]?.focus()
  }

  return (
    <div className="tabbar">
      <div ref={strip} className="tabbar-strip" role="tablist" aria-label="Open pages">
        {tabs.map((tab) => {
          const Icon = tab.path && /\.txt$/i.test(tab.path) ? File : FileText
          const title = titleOf(tab)
          return (
            <div
              key={tab.id}
              className="tab"
              role="tab"
              tabIndex={tab.id === activeId ? 0 : -1}
              aria-selected={tab.id === activeId}
              data-status={tab.status}
              title={tab.path ?? undefined}
              draggable
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id)
              }}
              onMouseDown={(event) => {
                // Stops the middle button starting a scroll.
                if (event.button === 1) event.preventDefault()
              }}
              onContextMenu={(event) => openMenu(tab.id, event)}
              onDragStart={(event) => startDrag(tab.id, event)}
              onDragOver={(event) => dragOver(tab.id, event)}
              onDragEnd={() => {
                dragging.current = null
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(tab.id)
                } else moveFocus(event)
              }}
            >
              <Icon size={15} strokeWidth={1.6} className="tab-icon" />
              <span className="tab-name">{title}</span>
              {tab.status !== 'saved' && <span className="tab-dot" aria-label="Not saved yet" />}
              <button
                type="button"
                className="icon-button small tab-close"
                aria-label={`Close ${title}`}
                title="Close tab (Ctrl+W)"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id)
                }}
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="icon-button tabbar-new" aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNew}>
        <Plus size={16} />
      </button>

      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenu(null)
              onClose(menu.id)
            }}
          >
            <span className="menu-item-title">Close tab</span>
            <span className="menu-item-hint">Ctrl+W</span>
          </button>
          <button
            type="button"
            className="menu-item"
            disabled={tabs.length < 2}
            onClick={() => {
              setMenu(null)
              onCloseOthers(menu.id)
            }}
          >
            <span className="menu-item-title">Close other tabs</span>
          </button>
        </Popover>
      )}
    </div>
  )
}
