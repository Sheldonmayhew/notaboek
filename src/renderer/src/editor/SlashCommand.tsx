import { Extension, type Editor, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { filterBlocks, leaveList, type BlockType } from './blockTypes'
import { canInsertImages } from './images'

interface SlashListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface SlashListProps {
  items: BlockType[]
  command: (item: BlockType) => void
}

const SlashList = forwardRef<SlashListHandle, SlashListProps>(function SlashList({ items, command }, ref) {
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => setSelected(0), [items])

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (items.length === 0) return false
      if (event.key === 'ArrowDown') {
        setSelected((index) => (index + 1) % items.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setSelected((index) => (index + items.length - 1) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        command(items[selected])
        return true
      }
      return false
    }
  }))

  if (items.length === 0) return <div className="menu slash-menu menu-empty">No results</div>

  return (
    <div className="menu slash-menu" ref={list} role="listbox">
      <div className="menu-label">Basic blocks</div>
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            className="menu-item"
            role="option"
            aria-selected={index === selected}
            data-selected={index === selected}
            onMouseEnter={() => setSelected(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
          >
            <Icon size={18} strokeWidth={1.75} />
            <span className="menu-item-title">{item.title}</span>
            {item.shortcut && <span className="menu-item-hint">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
})

const slashKey = new PluginKey('slashCommand')

export const closeSlashMenu = (editor: Editor) => exitSuggestion(editor.view, slashKey)

function createRenderer() {
  let component: ReactRenderer<SlashListHandle, SlashListProps> | null = null
  let dismiss: ((event: PointerEvent) => void) | null = null

  const place = async (props: SuggestionProps<BlockType, BlockType>) => {
    const rect = props.clientRect?.()
    const element = component?.element as HTMLElement | undefined
    if (!rect || !element) return
    const reference = { getBoundingClientRect: () => rect }
    const { x, y } = await computePosition(reference, element, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })]
    })
    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  return {
    onStart(props: SuggestionProps<BlockType, BlockType>) {
      component = new ReactRenderer(SlashList, {
        props: { items: props.items, command: props.command },
        editor: props.editor
      })
      const element = component.element as HTMLElement
      element.classList.add('slash-host')
      document.body.appendChild(element)
      dismiss = (event) => {
        if (!element.contains(event.target as Node)) exitSuggestion(props.editor.view, slashKey)
      }
      window.addEventListener('pointerdown', dismiss, true)
      void place(props)
    },
    onUpdate(props: SuggestionProps<BlockType, BlockType>) {
      component?.updateProps({ items: props.items, command: props.command })
      void place(props)
    },
    onKeyDown({ event, view }: SuggestionKeyDownProps) {
      if (event.key === 'Escape') {
        exitSuggestion(view, slashKey)
        return true
      }
      return component?.ref?.onKeyDown(event) ?? false
    },
    onExit() {
      if (dismiss) window.removeEventListener('pointerdown', dismiss, true)
      dismiss = null
      component?.element.remove()
      component?.destroy()
      component = null
    }
  }
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockType, BlockType>({
        pluginKey: slashKey,
        editor: this.editor,
        char: '/',
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.spec.code) return false
          // Markdown table cells hold a single line, so blocks can't be saved there.
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.spec.tableRole) return false
          }
          return true
        },
        items: ({ query, editor }) =>
          filterBlocks(query).filter((block) => block.id !== 'image' || canInsertImages(editor)),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: BlockType }) => {
          editor.chain().focus().deleteRange(range).run()
          leaveList(editor, props)
          props.apply(editor.chain().focus()).run()
        },
        render: createRenderer
      })
    ]
  }
})
