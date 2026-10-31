import { Node, mergeAttributes } from '@tiptap/core'

// The kinds GitHub understands as `> [!KIND]`, so callouts stay portable.
export const CALLOUT_KINDS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

const ICONS: Record<CalloutKind, string> = {
  NOTE: '📝',
  TIP: '💡',
  IMPORTANT: '📌',
  WARNING: '⚠️',
  CAUTION: '🚨'
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (kind?: CalloutKind) => ReturnType
    }
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'TIP',
        parseHTML: (el) => el.getAttribute('data-kind') ?? 'TIP',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0]
  },

  addCommands() {
    return {
      setCallout:
        (kind = 'TIP') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind })
    }
  },

  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of a callout unwraps it, like any other block.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parentOffset !== 0) return false
        for (let depth = $from.depth - 1; depth > 0; depth--) {
          if ($from.index(depth) !== 0) return false
          if ($from.node(depth).type.name === this.name) return editor.commands.lift(this.name)
        }
        return false
      }
    }
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'callout'
      dom.dataset.kind = node.attrs.kind

      const icon = document.createElement('button')
      icon.className = 'callout-icon'
      icon.type = 'button'
      icon.contentEditable = 'false'
      icon.title = 'Change callout type'
      icon.textContent = ICONS[node.attrs.kind as CalloutKind] ?? ICONS.TIP
      icon.addEventListener('mousedown', (event) => event.preventDefault())
      icon.addEventListener('click', () => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        const index = CALLOUT_KINDS.indexOf(current.attrs.kind)
        const kind = CALLOUT_KINDS[(index + 1) % CALLOUT_KINDS.length]
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'kind', kind))
      })

      const contentDOM = document.createElement('div')
      contentDOM.className = 'callout-body'
      dom.append(icon, contentDOM)

      return {
        dom,
        contentDOM,
        update: (updated) => {
          if (updated.type !== current.type) return false
          current = updated
          dom.dataset.kind = updated.attrs.kind
          icon.textContent = ICONS[updated.attrs.kind as CalloutKind] ?? ICONS.TIP
          return true
        }
      }
    }
  }
})
