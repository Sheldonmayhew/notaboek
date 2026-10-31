import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

type Property = [key: string, value: string]

function parseProperties(frontmatter: string): Property[] {
  const properties: Property[] = []
  for (const line of frontmatter.split('\n')) {
    const match = /^([\w -]+):\s*(.*)$/.exec(line)
    if (match) properties.push([match[1], match[2].replace(/^["']|["']$/g, '')])
  }
  return properties
}

function valueElement(value: string): HTMLElement {
  const cell = document.createElement('dd')
  const list = /^\[(.*)\]$/.exec(value)
  if (!value) {
    cell.textContent = 'Empty'
    cell.className = 'property-empty'
  } else if (list) {
    for (const item of list[1].split(',').map((part) => part.trim()).filter(Boolean)) {
      const tag = document.createElement('span')
      tag.className = 'property-tag'
      tag.textContent = item
      cell.append(tag)
    }
  } else {
    cell.textContent = value
  }
  return cell
}

function renderProperties(properties: Property[]): HTMLElement {
  const list = document.createElement('dl')
  list.className = 'properties'
  for (const [key, value] of properties) {
    const row = document.createElement('div')
    row.className = 'property'
    const label = document.createElement('dt')
    label.textContent = key
    row.append(label, valueElement(value))
    list.append(row)
  }
  return list
}

const leadsWithTitle = (doc: PMNode) => {
  const first = doc.firstChild
  return first?.type.name === 'heading' && first.attrs.level === 1
}

function decorate(doc: PMNode, properties: Property[]): DecorationSet {
  const titled = leadsWithTitle(doc)
  const title = titled ? doc.firstChild?.textContent : null
  const visible = properties.filter(([key, value]) => !(key === 'title' && value === title))
  if (visible.length === 0) return DecorationSet.empty

  // Under the page title, like any other page property.
  const position = titled ? (doc.firstChild?.nodeSize ?? 0) : 0
  const widget = Decoration.widget(position, () => renderProperties(visible), {
    key: JSON.stringify(visible),
    side: -1,
    ignoreSelection: true
  })
  return DecorationSet.create(doc, [widget])
}

// Frontmatter is shown read-only. It stays exactly as written in the file, so
// it lives beside the document rather than in it.
export const PageProperties = Extension.create<{ frontmatter: string | null }>({
  name: 'pageProperties',

  addOptions() {
    return { frontmatter: null }
  },

  addProseMirrorPlugins() {
    const properties = parseProperties(this.options.frontmatter ?? '')
    if (properties.length === 0) return []

    return [
      new Plugin({
        key: new PluginKey('pageProperties'),
        props: { decorations: (state) => decorate(state.doc, properties) }
      })
    ]
  }
})
