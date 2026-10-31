import {
  ChevronRight,
  ChevronsLeft,
  ChevronsUpDown,
  File,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPen,
  FolderSearch,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import type { SyncStatus, TreeEntry } from '../../../shared/api'
import { api, baseName, dirName, isInside, samePath, stripExtension } from '../platform'
import { AccountRow } from './AccountRow'
import { Popover } from './Popover'

interface SidebarProps {
  workspace: string
  defaultFolder: string
  activePath: string | null
  version: number
  expanded: Set<string>
  width: number
  floating: boolean
  onWidth: (width: number) => void
  onToggleFolder: (path: string) => void
  onOpen: (path: string) => void
  onNewPage: (dir: string) => void
  onRename: (path: string, name: string) => void
  // Both resolve to whether anything happened, so a cancelled action keeps the selection.
  onTrash: (paths: string[]) => Promise<boolean>
  onMove: (paths: string[], dir: string | null) => Promise<boolean>
  onOpenFolder: () => void
  onOpenFile: () => void
  onOpenDefaultFolder: () => void
  onChangeDefaultFolder: () => void
  onShowDefaultFolder: () => void
  onCollapse: () => void
  syncStatus: SyncStatus
  onSignIn: () => void
}

interface RowMenu {
  entry: TreeEntry
  anchor: { getBoundingClientRect: () => DOMRect }
}

function RenameInput({ entry, onDone }: { entry: TreeEntry; onDone: (name: string | null) => void }) {
  const keepExtension = entry.kind === 'file'
  const [value, setValue] = useState(keepExtension ? stripExtension(entry.name) : entry.name)
  const done = useRef(false)

  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }

  return (
    <input
      className="tree-rename"
      autoFocus
      value={value}
      aria-label="New name"
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => {
        // Switching to another window isn't the same as finishing the name.
        if (document.hasFocus()) finish(value)
      }}
      onKeyDown={(event) => {
        // The row behind this box opens its page on Enter, by the old name.
        event.stopPropagation()
        if (event.key === 'Enter') finish(value)
        if (event.key === 'Escape') finish(null)
      }}
    />
  )
}

interface TreeProps extends Pick<SidebarProps, 'activePath' | 'version' | 'expanded' | 'onNewPage' | 'onRename'> {
  dir: string
  depth: number
  renaming: string | null
  selected: Set<string>
  dropTarget: string | null
  onRenamed: () => void
  onMenu: (menu: RowMenu) => void
  onRowClick: (entry: TreeEntry, event: MouseEvent) => void
  onRowKey: (entry: TreeEntry, event: KeyboardEvent<HTMLElement>) => void
  onRowDrag: (entry: TreeEntry, event: DragEvent) => void
  onRowDragOver: (entry: TreeEntry, event: DragEvent) => void
  onRowDrop: (event: DragEvent) => void
  onDragDone: () => void
}

function Tree(props: TreeProps) {
  const { dir, depth, version, activePath, expanded, renaming, selected, dropTarget } = props
  const [entries, setEntries] = useState<TreeEntry[] | null>(null)

  useEffect(() => {
    let current = true
    api.listDir(dir).then(
      (result) => current && setEntries(result),
      () => current && setEntries([])
    )
    return () => {
      current = false
    }
  }, [dir, version])

  if (entries === null) return null
  if (entries.length === 0) {
    return (
      <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>
        {depth === 0 ? 'No pages here yet' : 'Empty'}
      </div>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        const isFolder = entry.kind === 'folder'
        const open = isFolder && expanded.has(entry.path)
        const isText = /\.txt$/i.test(entry.name)
        const Icon = isFolder ? (open ? FolderOpen : Folder) : isText ? File : FileText
        const isActive = samePath(entry.path, activePath)
        const isSelected = selected.has(entry.path)

        const openMenu = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
          const { clientX, clientY } = event
          const rect = new DOMRect(clientX, clientY, 0, 0)
          props.onMenu({ entry, anchor: { getBoundingClientRect: () => rect } })
        }

        return (
          <div key={entry.path}>
            <div
              className="tree-row"
              role="treeitem"
              tabIndex={0}
              aria-selected={isSelected || isActive}
              aria-expanded={isFolder ? open : undefined}
              data-path={entry.path}
              data-active={isActive}
              data-selected={isSelected}
              data-drop={samePath(entry.path, dropTarget)}
              draggable={renaming !== entry.path}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={(event) => props.onRowClick(entry, event)}
              onKeyDown={(event) => props.onRowKey(entry, event)}
              onContextMenu={openMenu}
              onDragStart={(event) => props.onRowDrag(entry, event)}
              onDragEnd={props.onDragDone}
              onDragOver={(event) => props.onRowDragOver(entry, event)}
              onDrop={props.onRowDrop}
            >
              <span className="tree-chevron" data-open={open}>
                {isFolder && <ChevronRight size={14} strokeWidth={2} />}
              </span>
              <Icon size={17} strokeWidth={1.6} className="tree-icon" />
              {renaming === entry.path ? (
                <RenameInput
                  entry={entry}
                  onDone={(name) => {
                    props.onRenamed()
                    const extension = isFolder ? '' : /\.[^.]+$/.exec(entry.name)?.[0] ?? ''
                    if (name?.trim()) props.onRename(entry.path, `${name.trim()}${extension}`)
                  }}
                />
              ) : (
                <span className="tree-name">
                  {isFolder ? entry.name : stripExtension(entry.name)}
                  {isText && <span className="tree-ext">.txt</span>}
                </span>
              )}
              <span className="tree-actions">
                <button type="button" className="icon-button small" aria-label="More options" onClick={openMenu}>
                  <MoreHorizontal size={15} />
                </button>
                {isFolder && (
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`New page in ${entry.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onNewPage(entry.path)
                    }}
                  >
                    <Plus size={15} />
                  </button>
                )}
              </span>
            </div>
            {open && <Tree {...props} dir={entry.path} depth={depth + 1} />}
          </div>
        )
      })}
    </>
  )
}

export function Sidebar(props: SidebarProps) {
  const { defaultFolder, onOpenDefaultFolder, onChangeDefaultFolder, onShowDefaultFolder } = props
  const { workspace, activePath, width, floating, onWidth, onCollapse, onNewPage } = props
  const { onOpen, onToggleFolder, onOpenFolder, onOpenFile, onTrash, onMove, syncStatus, onSignIn } = props
  const { localFiles, sync } = api.capabilities
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const switcher = useRef<HTMLButtonElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  // The row a Shift range starts from, and that a first Ctrl+click adds to.
  const anchor = useRef<string | null>(null)
  const dragging = useRef<string[] | null>(null)
  const name = baseName(workspace)

  const treeRows = () => [...(tree.current?.querySelectorAll<HTMLElement>('.tree-row') ?? [])]
  const visiblePaths = () => treeRows().map((row) => row.dataset.path ?? '')
  const clearSelection = () => {
    setSelected(new Set())
    anchor.current = null
  }

  useEffect(clearSelection, [workspace])

  useEffect(() => {
    if (!samePath(activePath, anchor.current)) anchor.current = null
  }, [activePath])

  // A folder already carries whatever is selected inside it.
  const outermost = (paths: Set<string>) => {
    const shown = visiblePaths().filter((path) => paths.has(path))
    return shown.filter((path) => !shown.some((other) => isInside(path, other)))
  }

  const targetsOf = (entry: TreeEntry) => (selected.has(entry.path) ? outermost(selected) : [entry.path])

  const trash = (paths: string[]) => {
    void onTrash(paths).then((done) => done && clearSelection())
  }

  const move = (paths: string[], dir: string | null) => {
    void onMove(paths, dir).then((done) => done && clearSelection())
  }

  const activate = (entry: TreeEntry) => {
    clearSelection()
    anchor.current = entry.path
    if (entry.kind === 'folder') onToggleFolder(entry.path)
    else onOpen(entry.path)
  }

  const toggle = (path: string) => {
    const previous = anchor.current
    setSelected((current) => {
      // The row clicked before this one counts too, as it does in File Explorer.
      const next = new Set(current.size === 0 && previous ? [previous] : current)
      if (!next.delete(path)) next.add(path)
      return next
    })
    anchor.current = path
  }

  const selectTo = (path: string) => {
    const paths = visiblePaths()
    const end = paths.indexOf(path)
    const found = paths.findIndex((item) => samePath(item, anchor.current ?? activePath))
    const start = found === -1 ? end : found
    anchor.current = paths[start]
    setSelected(new Set(paths.slice(Math.min(start, end), Math.max(start, end) + 1)))
  }

  const clickRow = (entry: TreeEntry, event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) toggle(entry.path)
    else if (event.shiftKey) selectTo(entry.path)
    else activate(entry)
  }

  const rowKey = (entry: TreeEntry, event: KeyboardEvent<HTMLElement>) => {
    // Keys pressed on one of the row's own buttons belong to that button.
    if (event.target !== event.currentTarget) return
    const { key, ctrlKey, shiftKey } = event

    if (key === 'Enter') {
      activate(entry)
    } else if (key === 'Delete') {
      event.preventDefault()
      trash(targetsOf(entry))
    } else if (key === 'Escape') {
      clearSelection()
    } else if (key === ' ' && (ctrlKey || shiftKey)) {
      event.preventDefault()
      if (ctrlKey) toggle(entry.path)
      else selectTo(entry.path)
    } else if (key.toLowerCase() === 'a' && ctrlKey) {
      event.preventDefault()
      setSelected(new Set(visiblePaths()))
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      const rows = treeRows()
      const next = rows[rows.indexOf(event.currentTarget) + (key === 'ArrowDown' ? 1 : -1)]
      if (!next) return
      next.focus()
      if (!shiftKey) return
      if (selected.size === 0) anchor.current = entry.path
      selectTo(next.dataset.path ?? '')
    }
  }

  const startDrag = (entry: TreeEntry, event: DragEvent) => {
    const paths = targetsOf(entry)
    if (!selected.has(entry.path)) clearSelection()
    dragging.current = paths
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-folio-items', String(paths.length))
    if (paths.length < 2) return
    const label = document.createElement('div')
    label.className = 'tree-drag-label'
    label.textContent = `${paths.length} items`
    document.body.append(label)
    event.dataTransfer.setDragImage(label, 12, 12)
    setTimeout(() => label.remove())
  }

  const offerDrop = (dir: string, event: DragEvent) => {
    const paths = dragging.current
    if (!paths) return
    event.stopPropagation()
    const allowed =
      paths.every((path) => !samePath(path, dir) && !isInside(dir, path)) &&
      paths.some((path) => !samePath(dirName(path), dir))
    setDropTarget(allowed ? dir : null)
    if (!allowed) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const endDrag = () => {
    dragging.current = null
    setDropTarget(null)
  }

  const drop = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const paths = dragging.current
    const dir = dropTarget
    endDrag()
    if (paths && dir) move(paths, dir)
  }

  const openRowMenu = (next: RowMenu) => {
    if (!selected.has(next.entry.path)) clearSelection()
    setMenu(next)
  }

  const menuTargets = menu ? targetsOf(menu.entry) : []
  const menuCount = menuTargets.length
  const binLabel = localFiles
    ? `Move${menuCount === 1 ? '' : ` ${menuCount} items`} to Recycle Bin`
    : `Delete${menuCount === 1 ? '' : ` ${menuCount} items`}`

  const startResize = (event: PointerEvent) => {
    const start = event.clientX
    const initial = width
    const moveEdge = (next: globalThis.PointerEvent) => {
      onWidth(Math.min(460, Math.max(200, initial + next.clientX - start)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', moveEdge)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', moveEdge)
    window.addEventListener('pointerup', stop)
  }

  return (
    <aside className="sidebar" data-floating={floating} style={{ width }}>
      <div className="sidebar-top">
        <button
          ref={switcher}
          type="button"
          className="workspace"
          disabled={!localFiles}
          onClick={() => setWorkspaceMenu((open) => !open)}
        >
          <span className="workspace-mark">{name.charAt(0).toUpperCase()}</span>
          <span className="workspace-name">{name}</span>
          {localFiles && <ChevronsUpDown size={14} className="workspace-chevron" />}
        </button>
        <button
          type="button"
          className="icon-button sidebar-collapse"
          aria-label="Hide sidebar"
          title="Hide sidebar (Ctrl+\)"
          onClick={onCollapse}
        >
          <ChevronsLeft size={18} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New page"
          title="New page (Ctrl+N)"
          onClick={() => onNewPage(workspace)}
        >
          <SquarePen size={17} />
        </button>
      </div>

      <div className="sidebar-section">Pages</div>
      <div
        ref={tree}
        className="sidebar-tree"
        role="tree"
        aria-label="Pages"
        aria-multiselectable="true"
        data-drop={samePath(dropTarget, workspace)}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection()
        }}
        onDragOver={(event) => offerDrop(workspace, event)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={drop}
      >
        <Tree
          {...props}
          dir={workspace}
          depth={0}
          renaming={renaming}
          selected={selected}
          dropTarget={dropTarget}
          onRenamed={() => setRenaming(null)}
          onMenu={openRowMenu}
          onRowClick={clickRow}
          onRowKey={rowKey}
          onRowDrag={startDrag}
          onRowDragOver={(entry, event) =>
            offerDrop(entry.kind === 'folder' ? entry.path : dirName(entry.path), event)
          }
          onRowDrop={drop}
          onDragDone={endDrag}
        />
      </div>

      {selected.size > 1 && (
        <div className="sidebar-selection" role="toolbar" aria-label="Selected items">
          <span>{selected.size} selected</span>
          {localFiles && (
            <button
              type="button"
              className="icon-button small"
              aria-label="Move selected items"
              title="Move to…"
              onClick={() => move(outermost(selected), null)}
            >
              <FolderInput size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-button small"
            aria-label={localFiles ? 'Move selected items to the Recycle Bin' : 'Delete selected items'}
            title={localFiles ? 'Move to Recycle Bin' : 'Delete'}
            onClick={() => trash(outermost(selected))}
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className="icon-button small"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            onClick={clearSelection}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {sync && <AccountRow status={syncStatus} onSignIn={onSignIn} />}

      <button type="button" className="sidebar-new" onClick={() => onNewPage(workspace)}>
        <Plus size={17} /> New page
      </button>

      <div className="sidebar-resize" onPointerDown={startResize} />

      {workspaceMenu && switcher.current && (
        <Popover anchor={switcher.current} onClose={() => setWorkspaceMenu(false)}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setWorkspaceMenu(false)
              onOpenFolder()
            }}
          >
            <FolderOpen size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Open folder…</span>
            <span className="menu-item-hint">Ctrl+Shift+O</span>
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setWorkspaceMenu(false)
              onOpenFile()
            }}
          >
            <FileText size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Open file…</span>
            <span className="menu-item-hint">Ctrl+O</span>
          </button>
          <div className="menu-separator" />
          <div className="menu-label">New pages are saved in</div>
          <div className="menu-path" title={defaultFolder}>
            {defaultFolder}
          </div>
          {!samePath(workspace, defaultFolder) && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setWorkspaceMenu(false)
                onOpenDefaultFolder()
              }}
            >
              <Folder size={18} strokeWidth={1.75} />
              <span className="menu-item-title">Open default folder</span>
            </button>
          )}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setWorkspaceMenu(false)
              onShowDefaultFolder()
            }}
          >
            <FolderSearch size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Show in File Explorer</span>
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setWorkspaceMenu(false)
              onChangeDefaultFolder()
            }}
          >
            <FolderPen size={18} strokeWidth={1.75} />
            <span className="menu-item-title">Change default folder…</span>
          </button>
        </Popover>
      )}

      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          {menuCount === 1 && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setRenaming(menu.entry.path)
                setMenu(null)
              }}
            >
              <Pencil size={18} strokeWidth={1.75} />
              <span className="menu-item-title">Rename</span>
            </button>
          )}
          {localFiles && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                move(menuTargets, null)
                setMenu(null)
              }}
            >
              <FolderInput size={18} strokeWidth={1.75} />
              <span className="menu-item-title">{menuCount === 1 ? 'Move to…' : `Move ${menuCount} items to…`}</span>
            </button>
          )}
          {menuCount === 1 && localFiles && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                api.reveal(menu.entry.path)
                setMenu(null)
              }}
            >
              <FolderSearch size={18} strokeWidth={1.75} />
              <span className="menu-item-title">Show in File Explorer</span>
            </button>
          )}
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item menu-item-danger"
            onClick={() => {
              trash(menuTargets)
              setMenu(null)
            }}
          >
            <Trash2 size={18} strokeWidth={1.75} />
            <span className="menu-item-title">{binLabel}</span>
          </button>
        </Popover>
      )}
    </aside>
  )
}
