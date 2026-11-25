import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Code, Copy, FolderOpen, LoaderCircle, Maximize2, PanelTop, Workflow } from 'lucide-react'
import { chatImageUrl, type ChatReplyDiagram, type ChatReplyDiagramError } from '../../shared/agent-chat'
import { prDiagramCaption, prDiagramHash } from '../../shared/pr-diagram'
import { useHost } from '../HostContext'
import type { ResourceActionHandler } from '../paneManagementApi'
import { ChatBlock, useTransientStatus, type ChatBlockAction } from './ChatBlock'
import { ImageViewer, type ViewableImage } from './ChatImages'

/** A local file a diagram was read from, which it can reveal or open as a tile. */
export type DiagramFile = { path: string; onAction?: ResourceActionHandler }

/**
 * A diagram's SVG as a standalone document: width and height from its
 * viewBox (Mermaid sizes to its container), and serialised as XML, so it
 * opens as an image and draws on a canvas.
 */
export function standaloneSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const box = copy.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) {
    copy.setAttribute('width', String(Math.ceil(box[2])))
    copy.setAttribute('height', String(Math.ceil(box[3])))
    copy.style.removeProperty('max-width')
  }
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(copy)
}

/** Draws an image as a PNG at twice its size, on the theme's surface so a dark diagram stays legible when pasted. */
async function pngOf(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const width = image.naturalWidth || 1200
    const height = image.naturalHeight || 800
    const scale = Math.min(2, 8192 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas')
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#100d1a'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => png ? resolve(png) : reject(new Error('No PNG')), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.blob()
}

export function DiagramBlock({ title, detail, source, imageUrl, svg, file, error, inline, children }: {
  title: string
  detail?: string
  /** What Source shows (Mermaid or JSON); without it there is no Source toggle. */
  source?: string
  /** The picture as a stored image, to expand and copy. */
  imageUrl?: string
  /** Or its SVG markup, read when it is needed. */
  svg?: () => string | null
  file?: DiagramFile
  /** Why there is no picture; shown above the source. */
  error?: string
  inline?: boolean
  /** The picture. */
  children?: ReactNode
}) {
  const { local } = useHost()
  const [showSource, setShowSource] = useState(Boolean(error))
  const [viewer, setViewer] = useState<ViewableImage | null>(null)
  const [status, flash] = useTransientStatus()
  const picture = !error && Boolean(imageUrl || svg)
  const sourceShown = Boolean(source) && (showSource || !picture)

  // A viewer opened from markup holds a blob URL until it closes.
  useEffect(() => () => { if (viewer?.src.startsWith('blob:')) URL.revokeObjectURL(viewer.src) }, [viewer])

  const pictureBlob = async (): Promise<Blob> => {
    if (imageUrl) return fetchBlob(imageUrl)
    const markup = svg?.()
    if (!markup) throw new Error('Diagram is not drawn yet')
    return new Blob([markup], { type: 'image/svg+xml' })
  }

  const expand = () => {
    if (imageUrl) return setViewer({ src: imageUrl, name: title })
    const markup = svg?.()
    if (markup) setViewer({ src: URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' })), name: title })
  }

  const copy = async () => {
    try {
      if (sourceShown && source) {
        await navigator.clipboard.writeText(source)
        return flash('Copied source')
      }
      try {
        // The PNG is drawn inside the clipboard item, so Safari still counts the click as the gesture.
        const png = pictureBlob().then(pngOf)
        png.catch(() => {})
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        flash('Copied image')
      } catch {
        // No image clipboard (or a canvas the SVG taints): the SVG itself is the next best thing.
        const markup = imageUrl ? (imageUrl.endsWith('.svg') ? await (await fetchBlob(imageUrl)).text() : null) : svg?.()
        if (!markup) throw new Error("Couldn't copy the image")
        await navigator.clipboard.writeText(markup)
        flash('Copied SVG')
      }
    } catch (failure) {
      flash(failure instanceof Error ? failure.message : "Couldn't copy")
    }
  }

  const fileAction = async (action: 'tile' | 'reveal') => {
    if (!file?.onAction) return
    try {
      await file.onAction(file.path, action)
    } catch (failure) {
      flash(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const canFile = Boolean(local && file?.onAction)
  const toolbar: ChatBlockAction[] = [
    ...(picture && !sourceShown ? [{ key: 'expand', label: 'Expand', icon: Maximize2, onSelect: expand }] : []),
    ...(canFile && /\.(?:svg|png|jpe?g|gif|webp)$/i.test(file!.path) ? [{ key: 'tile', label: 'Open as tile', icon: PanelTop, onSelect: () => void fileAction('tile') }] : []),
    ...(picture || source ? [{ key: 'copy', label: sourceShown ? 'Copy source' : 'Copy image', icon: Copy, onSelect: () => void copy() }] : []),
  ]
  const actions: ChatBlockAction[] = [
    ...(source && picture ? [{ key: 'source', label: showSource ? 'Show diagram' : 'Show source', text: 'Source', icon: Code, pressed: showSource, onSelect: () => setShowSource((value) => !value) }] : []),
    ...(canFile ? [{ key: 'reveal', label: 'Reveal in Finder', icon: FolderOpen, onSelect: () => void fileAction('reveal') }] : []),
  ]
  const Part = inline ? 'span' : 'div'
  return (
    <ChatBlock title={title} detail={detail} icon={Workflow} toolbar={toolbar} actions={actions} status={status} inline={inline}>
      {error ? <Part className="chat-block-error" role="alert">{error}</Part> : null}
      {sourceShown ? (
        inline ? <span className="chat-block-source"><code>{source}</code></span> : <pre className="chat-block-source"><code>{source}</code></pre>
      ) : picture ? (
        <Part className="chat-block-picture" onClick={expand} style={{ cursor: 'zoom-in' }}>{children}</Part>
      ) : null}
      <ImageViewer image={viewer} onClose={() => setViewer(null)} />
    </ChatBlock>
  )
}

/** The rendered pr-diagram fences of the reply being drawn; outside a reply, fences stay code. */
export const ReplyDiagramsContext = createContext<{ diagrams?: readonly ChatReplyDiagram[]; running?: boolean } | null>(null)

const DIAGRAM_ERRORS: Record<ChatReplyDiagramError, string> = {
  invalid: "This pr-diagram document isn't valid",
  too_large: 'This pr-diagram document is too large to render (64 KB at most)',
  timeout: 'The pr-diagram renderer took too long',
  failed: "Commando couldn't render this pr-diagram",
  renderer_missing: 'pr-diagram renderer not found',
}

/**
 * A ```pr-diagram fence. The daemon renders it (chat-reply-diagrams.ts) and
 * attaches the SVG under the source's hash; until then a streaming reply
 * shows a placeholder, and a renderer error shows above the source.
 */
export function PrDiagramFence({ source, fallback }: { source: string; fallback: ReactNode }) {
  const reply = use(ReplyDiagramsContext)
  const { local } = useHost()
  const hash = useMemo(() => prDiagramHash(source), [source])
  const caption = useMemo(() => prDiagramCaption(source), [source])
  if (!reply) return fallback
  const diagram = reply.diagrams?.find((entry) => entry.hash === hash)
  if (!diagram) {
    if (reply.running) {
      return <div className="chat-diagram-pending" role="status"><LoaderCircle aria-hidden="true" />Rendering diagram…</div>
    }
    return fallback
  }
  if ('error' in diagram && diagram.error === 'renderer_missing') {
    return <div><small className="chat-diagram-note">{DIAGRAM_ERRORS.renderer_missing}</small>{fallback}</div>
  }
  if (!local) return <div><small className="chat-diagram-note">Diagrams show on this Mac only for now</small>{fallback}</div>
  const title = caption.title ?? 'Diagram'
  const detail = caption.type ? `pr-diagram ${caption.type}` : 'pr-diagram'
  if ('error' in diagram) {
    const error = [DIAGRAM_ERRORS[diagram.error], diagram.message].filter(Boolean).join(':\n')
    return <DiagramBlock title={title} detail={detail} source={source} error={error} />
  }
  const url = chatImageUrl(diagram.id)
  return (
    <DiagramBlock title={title} detail={detail} source={source} imageUrl={url}>
      <img src={url} alt={title} draggable={false} />
    </DiagramBlock>
  )
}
