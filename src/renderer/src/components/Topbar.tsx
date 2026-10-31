import {
  Code2,
  FolderSearch,
  Maximize2,
  Menu as MenuIcon,
  Monitor,
  Moon,
  MoreHorizontal,
  Search,
  Sun,
  Type
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { SaveStatus } from '../doc/saveSession'
import { api, baseName, relativeTo, stripExtension } from '../platform'
import type { FontChoice, Prefs, ThemeChoice } from '../prefs'
import { Popover } from './Popover'

const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Editing…',
  saving: 'Saving…',
  conflict: 'Not saved',
  missing: 'Not saved',
  error: 'Not saved'
}

const FONTS: Array<{ id: FontChoice; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' }
]

const THEMES: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor }
]

interface TopbarProps {
  workspace: string
  path: string | null
  status: SaveStatus
  prefs: Prefs
  sourceMode: boolean
  sidebarVisible: boolean
  onPrefs: (change: Partial<Prefs>) => void
  onExpandSidebar: () => void
  onToggleSource: () => void
  onFind: () => void
  onReveal: () => void
  countWords: () => number
}

function Toggle({ on }: { on: boolean }) {
  return <span className="toggle" data-on={on} aria-hidden="true" />
}

export function Topbar(props: TopbarProps) {
  const { workspace, path, status, prefs, sourceMode, sidebarVisible, onPrefs } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [words, setWords] = useState(0)

  const crumbs = path
    ? relativeTo(workspace, path)
        .split(/[\\/]/)
        .map((part, index, parts) => (index === parts.length - 1 ? stripExtension(part) : part))
    : []

  return (
    <header className="topbar">
      {!sidebarVisible && (
        <button
          type="button"
          className="icon-button"
          aria-label="Show sidebar"
          title="Show sidebar (Ctrl+\)"
          onClick={props.onExpandSidebar}
        >
          <MenuIcon size={18} />
        </button>
      )}

      <nav className="breadcrumbs" aria-label="Location">
        <span className="crumb">{baseName(workspace)}</span>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb}-${index}`} className="crumb-group">
            <span className="crumb-separator">/</span>
            <span className="crumb" data-current={index === crumbs.length - 1}>
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      {path && (
        <div className="topbar-right">
          <span className="save-status" data-status={status} role="status">
            {STATUS_LABEL[status]}
          </span>
          <button
            ref={moreButton}
            type="button"
            className="icon-button"
            aria-label="Page options"
            onClick={() => {
              setWords(props.countWords())
              setMenuOpen((open) => !open)
            }}
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      )}

      {menuOpen && moreButton.current && (
        <Popover
          anchor={moreButton.current}
          placement="bottom-end"
          className="options-menu"
          onClose={() => setMenuOpen(false)}
        >
          <div className="menu-label">Style</div>
          <div className="font-picker">
            {FONTS.map((font) => (
              <button
                key={font.id}
                type="button"
                className="font-option"
                data-font={font.id}
                data-active={prefs.font === font.id}
                onClick={() => onPrefs({ font: font.id })}
              >
                <span className="font-sample">Ag</span>
                <span className="font-name">{font.label}</span>
              </button>
            ))}
          </div>
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenuOpen(false)
              props.onFind()
            }}
          >
            <Search size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Find in page</span>
            <span className="menu-item-hint">Ctrl+F</span>
          </button>
          <button type="button" className="menu-item" onClick={() => onPrefs({ smallText: !prefs.smallText })}>
            <Type size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Small text</span>
            <Toggle on={prefs.smallText} />
          </button>
          <button type="button" className="menu-item" onClick={() => onPrefs({ fullWidth: !prefs.fullWidth })}>
            <Maximize2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Full width</span>
            <Toggle on={prefs.fullWidth} />
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenuOpen(false)
              props.onToggleSource()
            }}
          >
            <Code2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">View source</span>
            <Toggle on={sourceMode} />
          </button>
          {api.capabilities.localFiles && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenuOpen(false)
                props.onReveal()
              }}
            >
              <FolderSearch size={18} strokeWidth={1.75} />
              <span className="menu-item-title">Show in File Explorer</span>
            </button>
          )}
          <div className="menu-separator" />
          <div className="menu-label">Theme</div>
          <div className="theme-picker">
            {THEMES.map((theme) => {
              const Icon = theme.icon
              return (
                <button
                  key={theme.id}
                  type="button"
                  className="theme-option"
                  data-active={prefs.theme === theme.id}
                  onClick={() => onPrefs({ theme: theme.id })}
                >
                  <Icon size={15} strokeWidth={1.75} /> {theme.label}
                </button>
              )
            })}
          </div>
          <div className="menu-separator" />
          <div className="menu-footer">Word count: {words.toLocaleString()}</div>
        </Popover>
      )}
    </header>
  )
}
