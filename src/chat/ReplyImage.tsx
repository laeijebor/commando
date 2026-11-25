import { useHost } from '../HostContext'
import { useState } from 'react'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { chatImageUrl, findChatReplyImage, type ChatReplyImage, type ChatReplyImageError } from '../../shared/agent-chat'
import type { ResourceActionHandler } from '../paneManagementApi'
import { ImageViewer } from './ChatImages'
import { DiagramBlock } from './DiagramBlock'

const NOTICES: Record<ChatReplyImageError | 'undrawable' | 'unresolved', string> = {
  missing: 'Image not found',
  unreadable: "Commando can't read this image (check its permissions)",
  unsupported: 'Not an image Commando can show',
  too_large: 'Image is too large to show',
  empty: 'Image file is empty',
  failed: "Commando couldn't store this image",
  undrawable: "Couldn't display this image",
  unresolved: "Image isn't available",
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function Notice({ reason, src, path }: { reason: keyof typeof NOTICES; src: string; path?: string }) {
  return (
    <span className="chat-reply-image-notice" role="img" aria-label={`${NOTICES[reason]}: ${src}`} title={path}>
      <ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{NOTICES[reason]}: <code>{src}</code></span>
    </span>
  )
}

/** An SVG, or a PNG whose caption or name says it is a diagram; other images (screenshots) stay plain. */
export function isDiagramImage(id: string, src: string, alt: string): boolean {
  if (id.endsWith('.svg')) return true
  return id.endsWith('.png') && /\b(?:diagram|architecture|flowchart|sequence|pr-diagram)\b/i.test(`${alt} ${fileName(src).replace(/[-_.]/g, ' ')}`)
}

/** A stored reply image; a click enlarges it. Keyed by id, so a newer copy of the file gets a fresh try. */
function StoredImage({ id, src, alt, path, onAction }: { id: string; src: string; alt: string; path?: string; onAction?: ResourceActionHandler }) {
  const { local } = useHost()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!local) return <span>Only on this Mac for now</span>
  if (failed) return <Notice reason="undrawable" src={src} />
  const url = chatImageUrl(id)
  const name = alt || fileName(src)
  if (isDiagramImage(id, src, alt)) {
    return (
      <DiagramBlock inline title={name} {...(alt ? { detail: fileName(src) } : {})} imageUrl={url} {...(path ? { file: { path, onAction } } : {})}>
        <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      </DiagramBlock>
    )
  }
  return (
    <>
      <button type="button" className="chat-reply-image" onClick={() => setOpen(true)} aria-label={`Open ${name}`} title={src}>
        <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      </button>
      <ImageViewer image={open ? { src: url, name } : null} onClose={() => setOpen(false)} />
    </>
  )
}

/**
 * An image in an agent's reply. A local file shows once the daemon has stored
 * it (`images`); a web address loads as before; anything else is named, never
 * shown as a broken image.
 */
export function ReplyImage({ src, alt, images, running, onAction }: { src: string; alt: string; images?: readonly ChatReplyImage[]; running?: boolean; onAction?: ResourceActionHandler }) {
  const image = findChatReplyImage(images, src)
  if (image && 'id' in image) return <StoredImage key={image.id} id={image.id} src={image.src} alt={alt} {...(image.path ? { path: image.path } : {})} onAction={onAction} />
  if (image) return <Notice reason={image.error} src={image.src} {...(image.path ? { path: image.path } : {})} />
  if (/^https?:\/\//i.test(src)) return <img src={src} alt={alt} className="chat-reply-web-image" />
  // Streaming: the daemon stores the file with the next update.
  if (running) {
    return (
      <span className="chat-reply-image-notice">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{alt || fileName(src)}</span>
      </span>
    )
  }
  return <Notice reason="unresolved" src={src} />
}
