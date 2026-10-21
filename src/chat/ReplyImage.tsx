import { useState } from 'react'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { chatImageUrl, findChatReplyImage, type ChatReplyImage, type ChatReplyImageError } from '../../shared/agent-chat'
import { ImageViewer } from './ChatImages'

const NOTICES: Record<ChatReplyImageError | 'unavailable' | 'unresolved', string> = {
  missing: 'Image not found',
  unsupported: 'Not an image Commando can show',
  too_large: 'Image is too large to show',
  unavailable: 'Image is no longer available',
  unresolved: "Image isn't available",
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/**
 * An image in an agent's reply. A local file shows once the daemon has stored
 * it (`images`); a web address loads as before; anything else is named, never
 * shown as a broken image.
 */
export function ReplyImage({ src, alt, images, running }: { src: string; alt: string; images?: readonly ChatReplyImage[]; running?: boolean }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const image = findChatReplyImage(images, src)
  if (image && 'id' in image && !failed) {
    const url = chatImageUrl(image.id)
    const name = alt || fileName(image.src)
    return (
      <>
        <button type="button" className="chat-reply-image" onClick={() => setOpen(true)} aria-label={`Open ${name}`} title={image.src}>
          <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} />
        </button>
        <ImageViewer image={open ? { src: url, name } : null} onClose={() => setOpen(false)} />
      </>
    )
  }
  if (!image && /^https?:\/\//i.test(src)) return <img src={src} alt={alt} className="chat-reply-web-image" />
  // Streaming: the daemon stores the file with the next update.
  if (!image && running) {
    return (
      <span className="chat-reply-image-notice">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{alt || fileName(src)}</span>
      </span>
    )
  }
  const reason = failed ? 'unavailable' : image && 'error' in image ? image.error : 'unresolved'
  return (
    <span className="chat-reply-image-notice" role="img" aria-label={`${NOTICES[reason]}: ${image?.src ?? src}`}>
      <ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{NOTICES[reason]}: <code>{image?.src ?? src}</code></span>
    </span>
  )
}
