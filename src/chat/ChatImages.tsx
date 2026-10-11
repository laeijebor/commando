import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { LoaderCircle, X } from 'lucide-react'
import { chatImageUrl, type ChatImageRef } from '../../shared/agent-chat'
import { cn } from './cn'

// Thumbnails and the enlarged view, after t3code's ComposerImageThumbnail and ExpandedImageDialog (MIT).

export interface ViewableImage {
  src: string
  name: string
}

/** The full-size image over the app; Esc or a click outside closes it. */
export function ImageViewer({ image, onClose }: { image: ViewableImage | null; onClose: () => void }) {
  return (
    <Dialog.Root open={image !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="chat-floating fixed inset-0 z-[140] bg-black/70" />
        <Dialog.Popup className="chat-floating fixed inset-0 z-[141] flex items-center justify-center p-4 outline-none" aria-label={image?.name ?? 'Image'}>
          {image ? (
            <figure className="relative flex max-h-full max-w-full flex-col items-center gap-2" onClick={onClose}>
              <img src={image.src} alt={image.name} className="max-h-[85vh] max-w-[92vw] rounded-md object-contain shadow-[0_8px_24px_rgb(0_0_0/45%)]" onClick={(event) => event.stopPropagation()} />
              <figcaption className="max-w-[92vw] truncate text-xs text-white/80">{image.name}</figcaption>
            </figure>
          ) : null}
          <Dialog.Close className="absolute top-3 right-3 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80" aria-label="Close image">
            <X className="size-4" aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Thumbnail({ src, name, onOpen, onRemove, busy, size = 'md' }: {
  src: string
  name: string
  onOpen: () => void
  onRemove?: () => void
  busy?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', size === 'sm' ? 'size-12' : 'size-16')}>
      <button
        type="button"
        onClick={onOpen}
        className="size-full cursor-zoom-in overflow-hidden rounded-md border border-border bg-background"
        aria-label={`Open ${name}`}
        title={name}
      >
        <img src={src} alt={name} className={cn('size-full object-cover', busy && 'opacity-50')} draggable={false} />
      </button>
      {busy ? <LoaderCircle className="pointer-events-none absolute inset-0 m-auto size-4 animate-spin text-primary" aria-label="Uploading" /> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-4.5 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${name}`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}

/** Stored images on a message or tool result; a click enlarges one. */
export function ImageStrip({ images, className, size }: { images: readonly ChatImageRef[]; className?: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState<ViewableImage | null>(null)
  return (
    <>
      <div className={cn('flex flex-wrap gap-1.5', className)}>
        {images.map((image, index) => {
          const viewable = { src: chatImageUrl(image.id), name: image.name ?? `Image ${index + 1}` }
          return <Thumbnail key={`${image.id}:${index}`} {...viewable} size={size} onOpen={() => setOpen(viewable)} />
        })}
      </div>
      <ImageViewer image={open} onClose={() => setOpen(null)} />
    </>
  )
}
