import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Film, ImageOff, LoaderCircle, Play, X, ZoomIn, ZoomOut } from 'lucide-react'
import { chatImageUrl, isChatVideoId, type ChatImageRef } from '../../shared/agent-chat'
import { cn } from './cn'
import { FIT, MAX_ZOOM, fitSize, panBy, zoomAround, type ImageZoom, type Size } from './imageZoom'

// Thumbnails and the enlarged view, after t3code's ComposerImageThumbnail and ExpandedImageDialog (MIT).

export interface ViewableImage {
  src: string
  name: string
  /** A video plays in the viewer instead of zooming. */
  video?: boolean
}

/** The full-size image over the app; Esc or a click outside closes it. It zooms and pans, or plays a video. */
export function ImageViewer({ image, onClose }: { image: ViewableImage | null; onClose: () => void }) {
  return (
    <Dialog.Root open={image !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        {/* Terminals and web tiles are native views above the page; the marker makes them hide under the viewer. */}
        <Dialog.Backdrop className="chat-floating fixed inset-0 z-[140] bg-black/70" data-native-terminal-occluder="" />
        <Dialog.Popup className="chat-floating fixed inset-0 z-[141] outline-none" aria-label={image?.name ?? 'Image'}>
          {image?.video ? <VideoPlayer key={image.src} video={image} onClose={onClose} /> : image ? <ZoomableImage key={image.src} image={image} onClose={onClose} /> : null}
          <Dialog.Close className="absolute top-3 right-3 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80" aria-label={image?.video ? 'Close video' : 'Close image'}>
            <X className="size-4" aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A video with the browser's own controls; a click beside it closes the viewer. */
function VideoPlayer({ video, onClose }: { video: ViewableImage; onClose: () => void }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-6" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <video src={video.src} controls autoPlay playsInline className="max-h-[85vh] max-w-[92vw] rounded-md bg-black" aria-label={video.name} />
      <p className="max-w-[92vw] truncate text-xs text-white/80">{video.name}</p>
    </div>
  )
}

/** Room the image opens in, as before zooming existed: 92% of the width, 85% of the height. */
const roomFor = (viewport: Size): Size => ({ w: viewport.w * 0.92, h: viewport.h * 0.85 })
const STEP = 1.5
/** Past a few pixels a press is a drag, and its release doesn't close the viewer. */
const DRAG_SLOP = 4

/**
 * Pinch, or Ctrl/⌘ and scroll, zooms at the pointer; scrolling pans once
 * zoomed (and zooms at fit, where there is nothing to pan). Drag pans,
 * double-click zooms in or back to fit, and + − 0 do the same from the keyboard.
 */
function ZoomableImage({ image, onClose }: { image: ViewableImage; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>({ w: window.innerWidth, h: window.innerHeight })
  const [natural, setNatural] = useState<Size | null>(null)
  const [zoom, setZoom] = useState<ImageZoom>(FIT)
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean; onBackdrop: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fitted = natural ? fitSize(natural, roomFor(viewport)) : null
  // The wheel listener and keys read the latest values without re-subscribing.
  const latest = useRef({ zoom, fitted, viewport })
  latest.current = { zoom, fitted, viewport }

  // The viewer fills the window, so the window's size is the viewport's.
  useEffect(() => {
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  /** A pointer position relative to the viewport's centre, the origin zoom works in. */
  const fromCentre = (clientX: number, clientY: number) => {
    const rect = viewportRef.current!.getBoundingClientRect()
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
  }

  const zoomTo = (scale: number, point = { x: 0, y: 0 }) => {
    const { zoom: current, fitted: size, viewport: room } = latest.current
    if (size) setZoom(zoomAround(current, scale, point, size, room))
  }

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    // Not a React handler: React's wheel listeners are passive, and the page must not zoom or scroll instead.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { zoom: current, fitted: size, viewport: room } = latest.current
      if (!size) return
      const lines = event.deltaMode === 1 ? 16 : 1
      const pinch = event.ctrlKey || event.metaKey
      if (!pinch && current.scale > 1) {
        setZoom(panBy(current, -event.deltaX * lines, -event.deltaY * lines, size, room))
        return
      }
      // A trackpad sends many small steps; a mouse notch is one big one, held to a 1.5× step.
      const factor = Math.min(STEP, Math.max(1 / STEP, Math.exp(-event.deltaY * lines * (pinch ? 0.01 : 0.002))))
      setZoom(zoomAround(current, current.scale * factor, fromCentre(event.clientX, event.clientY), size, room))
    }
    // Safari and the desktop app's WebKit view report a trackpad pinch as gesture events, not Ctrl-scroll.
    let pinchFrom = 1
    const onGestureStart = (event: Event) => {
      event.preventDefault()
      pinchFrom = latest.current.zoom.scale
    }
    const onGestureChange = (event: Event) => {
      event.preventDefault()
      const gesture = event as Event & { scale: number; clientX: number; clientY: number }
      zoomTo(pinchFrom * gesture.scale, fromCentre(gesture.clientX, gesture.clientY))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('gesturestart', onGestureStart)
    element.addEventListener('gesturechange', onGestureChange)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('gesturestart', onGestureStart)
      element.removeEventListener('gesturechange', onGestureChange)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === '+' || event.key === '=') zoomTo(latest.current.zoom.scale * STEP)
      else if (event.key === '-' || event.key === '_') zoomTo(latest.current.zoom.scale / STEP)
      else if (event.key === '0') setZoom(FIT)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    // Where the press began: once captured, the release always lands on the viewport itself.
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, onBackdrop: event.target === event.currentTarget }
    if (zoom.scale > 1) event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const press = drag.current
    if (!press || press.pointerId !== event.pointerId) return
    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (!press.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    if (!press.moved) setDragging(true)
    press.moved = true
    press.x = event.clientX
    press.y = event.clientY
    if (fitted && zoom.scale > 1) setZoom(panBy(zoom, dx, dy, fitted, viewport))
  }
  const onPointerUp = (event: ReactPointerEvent) => {
    const press = drag.current
    if (!press || press.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    // A click on the space around the image closes it, as before; a drag never does.
    if (!press.moved && press.onBackdrop) onClose()
  }

  const width = fitted ? fitted.w * zoom.scale : 0
  const height = fitted ? fitted.h * zoom.scale : 0
  const percent = natural && fitted ? Math.round((width / natural.w) * 100) : null
  return (
    <>
      <div
        ref={viewportRef}
        className={cn('absolute inset-0 overflow-hidden touch-none select-none', zoom.scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; setDragging(false) }}
        onDoubleClick={(event) => {
          if (zoom.scale > 1) setZoom(FIT)
          else zoomTo(2.5, fromCentre(event.clientX, event.clientY))
        }}
      >
        <img
          src={image.src}
          alt={image.name}
          draggable={false}
          // An SVG with only a viewBox may report no size: it opens filling the room instead.
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            setNatural(naturalWidth > 0 && naturalHeight > 0 ? { w: naturalWidth, h: naturalHeight } : roomFor(latest.current.viewport))
          }}
          className={cn('absolute max-w-none rounded-md shadow-[0_8px_24px_rgb(0_0_0/45%)]', zoom.scale === 1 && 'cursor-zoom-in', !fitted && 'invisible')}
          style={fitted ? {
            width,
            height,
            left: `calc(50% + ${zoom.x - width / 2}px)`,
            // Lifted a little, as when the caption sat under the image.
            top: `calc(50% - 12px + ${zoom.y - height / 2}px)`,
          } : undefined}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-1 text-xs text-white">
          <button type="button" className="flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-default disabled:opacity-40" onClick={() => zoomTo(zoom.scale / STEP)} disabled={zoom.scale <= 1} aria-label="Zoom out">
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <span className="min-w-12 text-center tabular-nums" aria-live="polite">{percent === null ? '' : `${percent}%`}</span>
          <button type="button" className="flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-default disabled:opacity-40" onClick={() => zoomTo(zoom.scale * STEP)} disabled={zoom.scale >= MAX_ZOOM} aria-label="Zoom in">
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
          <button type="button" className="h-7 cursor-pointer rounded-full px-2.5 hover:bg-white/15 disabled:cursor-default disabled:opacity-40" onClick={() => setZoom(FIT)} disabled={zoom.scale === 1} aria-label="Fit to screen">
            Fit
          </button>
        </div>
        <p className="max-w-[92vw] truncate text-xs text-white/80">{image.name}</p>
      </div>
    </>
  )
}

export function Thumbnail({ src, name, onOpen, onRemove, busy, video, size = 'md' }: {
  src: string
  name: string
  onOpen: () => void
  onRemove?: () => void
  busy?: boolean
  /** Shows the video's first frame with a play mark. */
  video?: boolean
  size?: 'sm' | 'md'
}) {
  // Pruned after 30 days, or never stored: say so instead of showing a broken image.
  const [missing, setMissing] = useState(false)
  // A video this browser can't decode (HEVC in Chromium, say) fails the same way as a pruned one, so it keeps a plain tile.
  const [noFrame, setNoFrame] = useState(false)
  return (
    <span className={cn('relative inline-flex shrink-0', size === 'sm' ? 'size-12' : 'size-16')}>
      {missing && !video ? (
        <span className="flex size-full items-center justify-center rounded-md border border-dashed border-border text-icon-muted" role="img" aria-label={`${name} is no longer available`} title={`${name} is no longer available`}>
          <ImageOff className="size-4" aria-hidden="true" />
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={cn('relative size-full overflow-hidden rounded-md border border-border bg-background', video ? 'cursor-pointer bg-black' : 'cursor-zoom-in')}
          aria-label={`${video ? 'Play' : 'Open'} ${name}`}
          title={name}
        >
          {video ? (
            <>
              {/* `#t=0.1` makes WebKit draw a first frame instead of a blank box. */}
              {noFrame ? (
                <Film className="absolute inset-0 m-auto size-5 text-white/70" aria-hidden="true" />
              ) : (
                <video src={`${src}#t=0.1`} muted playsInline preload="metadata" className={cn('pointer-events-none size-full object-cover', busy && 'opacity-50')} onError={() => setNoFrame(true)} />
              )}
              {busy || noFrame ? null : (
                <span className="pointer-events-none absolute inset-0 m-auto flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
                  <Play className="size-3 fill-current" aria-hidden="true" />
                </span>
              )}
            </>
          ) : (
            <img src={src} alt={name} className={cn('size-full object-cover', busy && 'opacity-50')} draggable={false} onError={() => setMissing(true)} />
          )}
        </button>
      )}
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
          const video = isChatVideoId(image.id)
          const viewable = { src: chatImageUrl(image.id), name: image.name ?? `${video ? 'Video' : 'Image'} ${index + 1}`, video }
          return <Thumbnail key={`${image.id}:${index}`} {...viewable} size={size} onOpen={() => setOpen(viewable)} />
        })}
      </div>
      <ImageViewer image={open} onClose={() => setOpen(null)} />
    </>
  )
}
