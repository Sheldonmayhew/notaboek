import { Circle, Highlighter, Lock, MousePointer2, Redo2, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import type { BinarySnapshot } from '../../../shared/api'
import type { DocumentWriter } from '../doc/documentSession'
import { friendlyError } from '../platform'
import type { PageHandle } from '../tabs'
import { loadPdf, pdfjs } from './pdfjs'
import {
  CIRCLE_LINE_WIDTH,
  newMarkId,
  normalizeBox,
  openPdfMarkup,
  unionBox,
  type Box,
  type MarkKind,
  type PdfMark,
  type PdfMarkup,
  type Rgb
} from './pdfMarks'

type Tool = 'select' | MarkKind

interface Swatch {
  label: string
  rgb: Rgb
}

const HIGHLIGHTS: Swatch[] = [
  { label: 'Yellow', rgb: [1, 0.85, 0.2] },
  { label: 'Green', rgb: [0.55, 0.88, 0.45] },
  { label: 'Blue', rgb: [0.5, 0.76, 1] },
  { label: 'Pink', rgb: [1, 0.6, 0.78] }
]

const PENS: Swatch[] = [
  { label: 'Red', rgb: [0.86, 0.15, 0.15] },
  { label: 'Blue', rgb: [0.12, 0.4, 0.88] },
  { label: 'Green', rgb: [0.1, 0.58, 0.26] },
  { label: 'Black', rgb: [0.12, 0.12, 0.12] }
]

// A PDF point is 1/72 of an inch and a CSS pixel 1/96, so 100% is this much bigger.
const CSS_UNITS = 96 / 72
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const MAX_FIT_ZOOM = 1.5
const PAGE_GUTTER = 24
// Past this a canvas costs too much memory, so a zoomed-in page is drawn a little softer.
const MAX_CANVAS_PIXELS = 16_000_000
const MIN_SHAPE = 4
const NO_MARKS: PdfMark[] = []

const cssColor = (rgb: Rgb) => `rgb(${rgb.map((value) => Math.round(value * 255)).join(' ')})`

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function viewRect(viewport: PageViewport, [x1, y1, x2, y2]: Box) {
  const [a, b] = viewport.convertToViewportPoint(x1, y1) as number[]
  const [c, d] = viewport.convertToViewportPoint(x2, y2) as number[]
  return { x: Math.min(a, c), y: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) }
}

function pdfBox(viewport: PageViewport, x1: number, y1: number, x2: number, y2: number): Box {
  const [a, b] = viewport.convertToPdfPoint(x1, y1) as number[]
  const [c, d] = viewport.convertToPdfPoint(x2, y2) as number[]
  return normalizeBox([a, b, c, d])
}

// The selected text, as boxes on the screen. Each text node is measured on its
// own, so the empty space around the text layer's blocks never counts.
function selectedTextRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer
  const nodes: Text[] = []
  if (root.nodeType === Node.TEXT_NODE) {
    nodes.push(root as Text)
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (range.intersectsNode(node)) nodes.push(node as Text)
    }
  }
  const rects: DOMRect[] = []
  for (const node of nodes) {
    if (!node.parentElement?.closest('.textLayer') || !node.data.trim()) continue
    const part = document.createRange()
    part.setStart(node, node === range.startContainer ? range.startOffset : 0)
    part.setEnd(node, node === range.endContainer ? range.endOffset : node.length)
    for (const rect of part.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect)
    }
  }
  return rects
}

// Joins the pieces of each line into one box, as a highlighter pen would draw it.
function mergeLines(boxes: Box[]): Box[] {
  const lines: Box[] = []
  for (const box of [...boxes].sort((a, b) => b[3] - a[3] || a[0] - b[0])) {
    const height = box[3] - box[1]
    const line = lines.find((other) => {
      const otherHeight = other[3] - other[1]
      const overlap = Math.min(other[3], box[3]) - Math.max(other[1], box[1])
      const gap = Math.max(other[0], box[0]) - Math.min(other[2], box[2])
      return overlap > 0.5 * Math.min(height, otherHeight) && gap < Math.max(height, otherHeight)
    })
    if (line) {
      line[0] = Math.min(line[0], box[0])
      line[1] = Math.min(line[1], box[1])
      line[2] = Math.max(line[2], box[2])
      line[3] = Math.max(line[3], box[3])
    } else {
      lines.push([...box])
    }
  }
  return lines
}

function hits(mark: PdfMark, [x, y]: number[], tolerance: number): boolean {
  if (mark.kind === 'highlight') {
    return mark.boxes.some(
      ([x1, y1, x2, y2]) => x >= x1 - tolerance && x <= x2 + tolerance && y >= y1 - tolerance && y <= y2 + tolerance
    )
  }
  const [x1, y1, x2, y2] = mark.boxes[0]
  const rx = (x2 - x1) / 2 + tolerance
  const ry = (y2 - y1) / 2 + tolerance
  const dx = (x - (x1 + x2) / 2) / rx
  const dy = (y - (y1 + y2) / 2) / ry
  return dx * dx + dy * dy <= 1
}

interface Draft {
  kind: MarkKind
  x1: number
  y1: number
  x2: number
  y2: number
}

interface PageProps {
  page: PDFPageProxy
  base: PageViewport
  index: number
  scale: number
  scroller: RefObject<HTMLDivElement | null>
  marks: PdfMark[]
  selectedId: string | null
  tool: Tool
  color: Rgb
  readOnly: boolean
  onDrawn: (index: number, kind: MarkKind, box: Box) => void
  onPoint: (index: number, point: number[]) => void
}

const PdfPage = memo(function PdfPage(props: PageProps) {
  const { page, base, index, scale, scroller, marks, selectedId, tool, color, readOnly } = props
  const viewport = useMemo(() => base.clone({ scale: scale * CSS_UNITS }), [base, scale])
  const element = useRef<HTMLDivElement>(null)
  const canvasHolder = useRef<HTMLDivElement>(null)
  const textHolder = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; drawing: boolean } | null>(null)
  const [visible, setVisible] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => {
    const target = element.current
    if (!target) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: scroller.current,
      rootMargin: '1200px 0px'
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [scroller])

  // Pages far from view give their memory back.
  useEffect(() => {
    if (visible) return
    canvasHolder.current?.replaceChildren()
    textHolder.current?.replaceChildren()
  }, [visible])

  // The new drawing replaces the old one only once it's ready, so zooming never
  // flashes a blank page.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const area = viewport.width * viewport.height
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / area))
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    const task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null
    task.promise
      .then(async () => {
        if (cancelled) return
        canvasHolder.current?.replaceChildren(canvas)
        const text = document.createElement('div')
        text.className = 'textLayer'
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport })
        await textLayer.render()
        if (!cancelled) textHolder.current?.replaceChildren(text)
      })
      .catch(() => {
        // Cancelled by a newer drawing, or a page pdf.js can't draw. Either way
        // the page stays blank rather than stopping the others.
      })
    return () => {
      cancelled = true
      task.cancel()
      textLayer?.cancel()
    }
  }, [visible, page, viewport])

  const local = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x, y) as number[]

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const { x, y } = local(event)
    const onText = (event.target as Element).closest('.textLayer span') !== null
    const drawing = !readOnly && (tool === 'circle' || (tool === 'highlight' && !onText))
    drag.current = { x, y, drawing }
    if (!drawing) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    window.getSelection()?.removeAllRanges()
    setDraft({ kind: tool as MarkKind, x1: x, y1: y, x2: x, y2: y })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start?.drawing) return
    let { x, y } = local(event)
    // Shift keeps a circle round.
    if (event.shiftKey && tool === 'circle') {
      const size = Math.max(Math.abs(x - start.x), Math.abs(y - start.y))
      x = start.x + Math.sign(x - start.x || 1) * size
      y = start.y + Math.sign(y - start.y || 1) * size
    }
    setDraft({ kind: tool as MarkKind, x1: start.x, y1: start.y, x2: x, y2: y })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    drag.current = null
    if (!start) return
    const { x, y } = local(event)
    const moved = Math.hypot(x - start.x, y - start.y) > 3
    if (start.drawing) {
      const shape = draft
      setDraft(null)
      if (shape && Math.abs(shape.x2 - shape.x1) > MIN_SHAPE && Math.abs(shape.y2 - shape.y1) > MIN_SHAPE) {
        props.onDrawn(index, shape.kind, pdfBox(viewport, shape.x1, shape.y1, shape.x2, shape.y2))
        return
      }
    }
    if (!moved) props.onPoint(index, toPdf(x, y))
  }

  const lineWidth = CIRCLE_LINE_WIDTH * viewport.scale
  const selected = marks.find((mark) => mark.id === selectedId)
  const outline = selected && viewRect(viewport, unionBox(selected.boxes))

  return (
    <div
      ref={element}
      className="pdf-page"
      data-index={index}
      style={
        {
          width: viewport.width,
          height: viewport.height,
          '--scale-factor': viewport.scale,
          '--total-scale-factor': viewport.scale
        } as React.CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null
        setDraft(null)
      }}
    >
      <div ref={canvasHolder} className="pdf-canvas" />
      <svg className="pdf-marks" width={viewport.width} height={viewport.height} aria-hidden="true">
        {marks.map((mark) => {
          if (mark.kind === 'highlight') {
            return (
              <g key={mark.id} fill={cssColor(mark.color)}>
                {mark.boxes.map((box, boxIndex) => (
                  <rect key={boxIndex} {...viewRect(viewport, box)} />
                ))}
              </g>
            )
          }
          const { x, y, width, height } = viewRect(viewport, mark.boxes[0])
          return (
            <ellipse
              key={mark.id}
              cx={x + width / 2}
              cy={y + height / 2}
              rx={Math.max(width / 2 - lineWidth / 2, 0.5)}
              ry={Math.max(height / 2 - lineWidth / 2, 0.5)}
              fill="none"
              stroke={cssColor(mark.color)}
              strokeWidth={lineWidth}
            />
          )
        })}
        {draft && draft.kind === 'highlight' && (
          <rect
            x={Math.min(draft.x1, draft.x2)}
            y={Math.min(draft.y1, draft.y2)}
            width={Math.abs(draft.x2 - draft.x1)}
            height={Math.abs(draft.y2 - draft.y1)}
            fill={cssColor(color)}
          />
        )}
        {draft && draft.kind === 'circle' && (
          <ellipse
            cx={(draft.x1 + draft.x2) / 2}
            cy={(draft.y1 + draft.y2) / 2}
            rx={Math.max(Math.abs(draft.x2 - draft.x1) / 2 - lineWidth / 2, 0.5)}
            ry={Math.max(Math.abs(draft.y2 - draft.y1) / 2 - lineWidth / 2, 0.5)}
            fill="none"
            stroke={cssColor(color)}
            strokeWidth={lineWidth}
          />
        )}
      </svg>
      <div ref={textHolder} className="pdf-text" />
      {outline && (
        <div
          className="pdf-selected"
          style={{ left: outline.x - 4, top: outline.y - 4, width: outline.width + 8, height: outline.height + 8 }}
        />
      )}
    </div>
  )
})

interface Loaded {
  pdf: PDFDocumentProxy
  pages: PDFPageProxy[]
  // Each page at 100%. Every other size is a copy of these.
  bases: PageViewport[]
  markup: PdfMarkup
}

interface PdfViewProps {
  snapshot: BinarySnapshot
  active: boolean
  view: RefObject<PageHandle | null>
  onWriter: (writer: DocumentWriter) => void
  onEdit: () => void
}

function describeFailure(error: unknown): string {
  const name = (error as Error)?.name
  if (name === 'PasswordException') return "This PDF needs a password, which Notaboek can't open."
  if (name === 'InvalidPDFException') return "This file isn't a PDF Notaboek can read. It may be damaged."
  return friendlyError(error)
}

export default function PdfView({ snapshot, active, view, ...props }: PdfViewProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [fitZoom, setFitZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('select')
  const [highlightColor, setHighlightColor] = useState(0)
  const [penColor, setPenColor] = useState(0)
  const [marks, setMarks] = useState<PdfMark[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [, setHistoryVersion] = useState(0)
  const marksRef = useRef(marks)
  const history = useRef<{ undo: PdfMark[][]; redo: PdfMark[][] }>({ undo: [], redo: [] })
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const scrollAnchor = useRef<number | null>(null)
  const scrolled = useRef(0)
  const callbacks = useRef(props)
  callbacks.current = props

  const scale = zoom ?? fitZoom
  const readOnly = loaded?.markup.readOnly ?? null

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof loadPdf> | null = null
    void (async () => {
      try {
        const markup = await openPdfMarkup(snapshot.bytes)
        if (cancelled) return
        task = loadPdf(markup.pageBytes)
        const pdf = await task.promise
        const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1)))
        if (cancelled) return
        marksRef.current = markup.marks
        setMarks(markup.marks)
        setLoaded({ pdf, pages, bases: pages.map((page) => page.getViewport({ scale: 1 })), markup })
        if (!markup.readOnly) callbacks.current.onWriter({ write: () => markup.save(marksRef.current) })
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error))
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [snapshot])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || !loaded) return
    const widest = Math.max(...loaded.bases.map((base) => base.width)) * CSS_UNITS
    const measure = () => {
      // A hidden tab has no width. It's measured again when it's shown.
      if (element.clientWidth === 0) return
      setFitZoom(clamp((element.clientWidth - PAGE_GUTTER * 2) / widest, ZOOM_STEPS[0], MAX_FIT_ZOOM))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [loaded])

  // A hidden tab loses its place, so it's put back when the tab shows again.
  useLayoutEffect(() => {
    if (active && scrolled.current > 0 && scroller.current) scroller.current.scrollTop = scrolled.current
  }, [active])

  // Zooming keeps the middle of the view where it was.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || scrollAnchor.current === null) return
    element.scrollTop = scrollAnchor.current * element.scrollHeight - element.clientHeight / 2
    scrollAnchor.current = null
  }, [scale])

  const changeZoom = (next: number | null) => {
    const element = scroller.current
    if (element && element.scrollHeight > 0) {
      scrollAnchor.current = (element.scrollTop + element.clientHeight / 2) / element.scrollHeight
    }
    setZoom(next)
  }

  const stepZoom = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((step) => step > scale + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001) ?? ZOOM_STEPS[0])
    changeZoom(next)
  }

  const replaceMarks = useCallback((next: PdfMark[]) => {
    marksRef.current = next
    setMarks(next)
    setHistoryVersion((version) => version + 1)
    callbacks.current.onEdit()
  }, [])

  const commit = useCallback(
    (next: PdfMark[]) => {
      history.current.undo.push(marksRef.current)
      history.current.redo = []
      replaceMarks(next)
    },
    [replaceMarks]
  )

  const travel = useCallback(
    (from: 'undo' | 'redo') => {
      const to = from === 'undo' ? 'redo' : 'undo'
      const target = history.current[from].pop()
      if (!target) return
      history.current[to].push(marksRef.current)
      setSelectedId(null)
      replaceMarks(target)
    },
    [replaceMarks]
  )

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit(marksRef.current.filter((mark) => mark.id !== selectedId))
    setSelectedId(null)
  }, [selectedId, commit])

  const highlightSelection = useCallback((): boolean => {
    const selection = window.getSelection()
    const pages = pagesRef.current
    if (!loaded || readOnly || !pages || !selection || selection.isCollapsed || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!pages.contains(range.commonAncestorContainer)) return false
    const pageElements = [...pages.querySelectorAll<HTMLElement>('.pdf-page')]
    const byPage = new Map<number, Box[]>()
    for (const rect of selectedTextRects(range)) {
      const middleX = rect.left + rect.width / 2
      const middleY = rect.top + rect.height / 2
      const element = pageElements.find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return middleX >= bounds.left && middleX <= bounds.right && middleY >= bounds.top && middleY <= bounds.bottom
      })
      if (!element) continue
      const index = Number(element.dataset.index)
      const bounds = element.getBoundingClientRect()
      const viewport = loaded.bases[index].clone({ scale: scale * CSS_UNITS })
      const box = pdfBox(
        viewport,
        rect.left - bounds.left,
        rect.top - bounds.top,
        rect.right - bounds.left,
        rect.bottom - bounds.top
      )
      byPage.set(index, [...(byPage.get(index) ?? []), box])
    }
    selection.removeAllRanges()
    const color = HIGHLIGHTS[highlightColor].rgb
    const added = [...byPage].map(
      ([page, boxes]): PdfMark => ({ id: newMarkId(), page, kind: 'highlight', color, boxes: mergeLines(boxes) })
    )
    if (added.length > 0) commit([...marksRef.current, ...added])
    return added.length > 0
  }, [loaded, readOnly, scale, highlightColor, commit])

  // A drag across text with the highlighter can end anywhere, even outside the page.
  useEffect(() => {
    if (tool !== 'highlight') return
    const finish = () => setTimeout(highlightSelection)
    document.addEventListener('pointerup', finish)
    return () => document.removeEventListener('pointerup', finish)
  }, [tool, highlightSelection])

  const onDrawn = useCallback(
    (page: number, kind: MarkKind, box: Box) => {
      const color = kind === 'highlight' ? HIGHLIGHTS[highlightColor].rgb : PENS[penColor].rgb
      const mark: PdfMark = { id: newMarkId(), page, kind, color, boxes: [box] }
      commit([...marksRef.current, mark])
    },
    [highlightColor, penColor, commit]
  )

  const onPoint = useCallback(
    (page: number, point: number[]) => {
      const tolerance = 4 / (scale * CSS_UNITS)
      const hit = [...marksRef.current].reverse().find((mark) => mark.page === page && hits(mark, point, tolerance))
      setSelectedId(hit?.id ?? null)
      root.current?.focus({ preventScroll: true })
    },
    [scale]
  )

  // Picking a colour while a mark is selected recolours it.
  const pickColor = (kind: MarkKind, index: number) => {
    if (kind === 'highlight') setHighlightColor(index)
    else setPenColor(index)
    const selected = marksRef.current.find((mark) => mark.id === selectedId)
    if (!selected || selected.kind !== kind || readOnly) return
    const rgb = (kind === 'highlight' ? HIGHLIGHTS : PENS)[index].rgb
    commit(marksRef.current.map((mark) => (mark.id === selected.id ? { ...mark, color: rgb } : mark)))
  }

  const chooseTool = (next: Tool) => {
    // With text already selected, the highlighter marks it straight away.
    if (next === 'highlight' && highlightSelection()) {
      setTool('highlight')
      return
    }
    setTool((current) => (current === next ? 'select' : next))
  }

  useImperativeHandle(view, () => ({
    openFind: () => undefined,
    stepFind: () => undefined,
    focus: () => root.current?.focus({ preventScroll: true })
  }))

  const marksByPage = useMemo(() => {
    const grouped = new Map<number, PdfMark[]>()
    for (const mark of marks) grouped.set(mark.page, [...(grouped.get(mark.page) ?? []), mark])
    return grouped
  }, [marks])

  const selectedKind = marks.find((mark) => mark.id === selectedId)?.kind
  const swatchKind: MarkKind | null = tool !== 'select' ? tool : (selectedKind ?? null)
  const swatches = swatchKind === 'circle' ? PENS : HIGHLIGHTS
  const chosen = swatchKind === 'circle' ? penColor : highlightColor

  return (
    <div
      ref={root}
      className="document-view pdf-view"
      data-tool={tool}
      tabIndex={-1}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('input, select, textarea')) return
        const key = event.key.toLowerCase()
        const command = event.ctrlKey || event.metaKey
        if ((key === 'delete' || key === 'backspace') && selectedId && !readOnly) {
          event.preventDefault()
          deleteSelected()
        } else if (key === 'escape') {
          setSelectedId(null)
          setTool('select')
        } else if (command && !event.altKey && key === 'z' && !readOnly) {
          event.preventDefault()
          travel(event.shiftKey ? 'redo' : 'undo')
        } else if (command && !event.altKey && key === 'y' && !readOnly) {
          event.preventDefault()
          travel('redo')
        }
      }}
    >
      <div className="document-toolbar" role="toolbar" aria-label="PDF tools" onMouseDown={(event) => event.preventDefault()}>
        {readOnly ? (
          <span className="document-note">
            <Lock size={15} strokeWidth={1.75} />
            {readOnly}
          </span>
        ) : (
          <>
            <div className="tool-group">
              <button
                type="button"
                className="tool-button"
                aria-pressed={tool === 'select'}
                title="Select text and marks"
                onClick={() => setTool('select')}
              >
                <MousePointer2 size={16} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="tool-button"
                aria-pressed={tool === 'highlight'}
                title="Highlight: drag across text, or draw a box"
                onClick={() => chooseTool('highlight')}
              >
                <Highlighter size={16} strokeWidth={1.75} />
                <span>Highlight</span>
              </button>
              <button
                type="button"
                className="tool-button"
                aria-pressed={tool === 'circle'}
                title="Circle: drag around something. Hold Shift for a round one"
                onClick={() => chooseTool('circle')}
              >
                <Circle size={16} strokeWidth={1.75} />
                <span>Circle</span>
              </button>
            </div>
            {swatchKind && (
              <div className="tool-group" role="radiogroup" aria-label="Colour">
                {swatches.map((swatch, index) => (
                  <button
                    key={swatch.label}
                    type="button"
                    role="radio"
                    className="color-swatch"
                    aria-checked={chosen === index}
                    aria-label={swatch.label}
                    title={swatch.label}
                    style={{ '--swatch': cssColor(swatch.rgb) } as React.CSSProperties}
                    onClick={() => pickColor(swatchKind, index)}
                  />
                ))}
              </div>
            )}
            <div className="tool-group">
              <button
                type="button"
                className="tool-button"
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                disabled={history.current.undo.length === 0}
                onClick={() => travel('undo')}
              >
                <Undo2 size={16} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="tool-button"
                title="Redo (Ctrl+Y)"
                aria-label="Redo"
                disabled={history.current.redo.length === 0}
                onClick={() => travel('redo')}
              >
                <Redo2 size={16} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="tool-button"
                title="Delete the selected mark (Delete)"
                aria-label="Delete mark"
                disabled={!selectedId}
                onClick={deleteSelected}
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          </>
        )}
        <div className="tool-spacer" />
        {loaded && (
          <div className="tool-group">
            <span className="document-note">
              {loaded.pdf.numPages === 1 ? '1 page' : `${loaded.pdf.numPages} pages`}
            </span>
            <button type="button" className="tool-button" aria-label="Zoom out" title="Zoom out" onClick={() => stepZoom(-1)}>
              <ZoomOut size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="tool-button zoom-level"
              title={zoom === null ? 'Fitting the width of the window' : 'Fit to width'}
              aria-pressed={zoom === null}
              onClick={() => changeZoom(null)}
            >
              {Math.round(scale * 100)}%
            </button>
            <button type="button" className="tool-button" aria-label="Zoom in" title="Zoom in" onClick={() => stepZoom(1)}>
              <ZoomIn size={16} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      <div
        className="scroller document-scroller"
        ref={scroller}
        onScroll={(event) => {
          if (active) scrolled.current = event.currentTarget.scrollTop
        }}
      >
        {failure && <div className="empty-state">{failure}</div>}
        {!failure && !loaded && <div className="empty-state">Opening…</div>}
        {loaded && (
          <div className="pdf-pages" ref={pagesRef}>
            {loaded.pages.map((page, index) => (
              <PdfPage
                key={index}
                page={page}
                base={loaded.bases[index]}
                index={index}
                scale={scale}
                scroller={scroller}
                marks={marksByPage.get(index) ?? NO_MARKS}
                selectedId={selectedId}
                tool={tool}
                color={tool === 'circle' ? PENS[penColor].rgb : HIGHLIGHTS[highlightColor].rgb}
                readOnly={readOnly !== null}
                onDrawn={onDrawn}
                onPoint={onPoint}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
