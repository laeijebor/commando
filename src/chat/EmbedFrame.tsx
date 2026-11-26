import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { AppWindow, FoldVertical, LayoutGrid, Maximize2, Minimize2, PanelTop, PenLine, UnfoldVertical } from 'lucide-react'
import type { ChatReplyEmbed, ChatReplyEmbedFrame, ChatReplyResource } from '../../shared/agent-chat'
import { useHost } from '../HostContext'
import type { ResourceActionHandler, ResourceActionOptions } from '../paneManagementApi'
import { ChatBlock, useTransientStatus, type ChatBlockAction } from './ChatBlock'
import { ResourceChip, resourceDirectory } from './ResourceChip'

/**
 * Where a host for interactive frames (MCP Apps, later) talks to the page.
 * `connect` runs once each time a frame element mounts, with the iframe, and
 * returns its cleanup. The frame is sandboxed without allow-same-origin, so
 * its messages arrive from origin "null": a bridge must check
 * `event.source === frame.contentWindow` and post with targetOrigin '*'.
 */
export type EmbedBridge = { connect: (frame: HTMLIFrameElement) => () => void }

export const EMBED_HEIGHT = 320
const TALL_EMBED_HEIGHT = 640
const THUMB_HEIGHT = 140
const THUMB_MAX_WIDTH = 240

type Props = {
  embed: ChatReplyEmbed
  /** The Markdown image's caption. */
  alt: string
  cwd: string
  onAction?: ResourceActionHandler
  bridge?: EmbedBridge
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

/**
 * While maximised, the block covers the chat pane. The pane sits inside
 * size-contained boxes (tiles, the timeline), which are the containing block
 * for `position: fixed`, so this measures that block and offsets the overlay
 * onto the pane's rectangle instead of the window's.
 */
function useChatPaneOverlay(anchor: RefObject<HTMLSpanElement | null>, maximised: boolean) {
  useLayoutEffect(() => {
    const host = anchor.current
    const block = host?.firstElementChild as HTMLElement | null
    const pane = host?.closest<HTMLElement>('[data-testid="chat-pane"]')
    if (!maximised || !host || !block || !pane) return
    const place = () => {
      const area = pane.getBoundingClientRect()
      for (const name of ['top', 'left']) host.style.setProperty(`--chat-embed-max-${name}`, '0px')
      const origin = block.getBoundingClientRect()
      host.style.setProperty('--chat-embed-max-top', `${area.top - origin.top}px`)
      host.style.setProperty('--chat-embed-max-left', `${area.left - origin.left}px`)
      host.style.setProperty('--chat-embed-max-width', `${area.width}px`)
      host.style.setProperty('--chat-embed-max-height', `${area.height}px`)
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(pane)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      for (const name of ['top', 'left', 'width', 'height']) host.style.removeProperty(`--chat-embed-max-${name}`)
    }
  }, [anchor, maximised])
}

/** Opens the embed as a side tile; a failure shows in the caption bar. */
function tileAction(embed: ChatReplyEmbed, onAction: ResourceActionHandler | undefined, flash: (message: string) => void, done: () => void) {
  if (!onAction || !embed.path) return undefined
  const path = embed.path
  return async (options?: ResourceActionOptions) => {
    try {
      const result = await onAction(path, 'tile', undefined, options)
      if (result.performed !== 'tile') flash('Opened outside Commando instead')
      done()
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error))
    }
  }
}

/** A frame's sandbox: scripts run, but the page gets an opaque origin, so it can't reach Commando or its cookies. */
function SandboxedFrame({ url, title, interactive, bridge, style, preview }: {
  url: string; title: string; interactive: boolean; bridge?: EmbedBridge; style?: CSSProperties; preview?: boolean
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const node = frame.current
    if (!bridge || !node) return
    return bridge.connect(node)
  }, [bridge])
  return (
    <iframe ref={frame} src={url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy"
      tabIndex={interactive ? 0 : -1} style={style} {...(preview ? { 'aria-hidden': true } : {})} />
  )
}

function HtmlEmbed({ embed, alt, cwd, onAction, bridge }: Props & { url: string }) {
  const [live, setLive] = useState(false)
  const [tall, setTall] = useState(false)
  const [maximised, setMaximised] = useState(false)
  const [status, flash] = useTransientStatus()
  const anchor = useRef<HTMLSpanElement>(null)
  useChatPaneOverlay(anchor, maximised)
  const interactive = live || maximised

  // A click back in the chat ends the live session, so the frame stops taking the wheel.
  useEffect(() => {
    if (!live || maximised) return
    const leave = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setLive(false)
    }
    document.addEventListener('pointerdown', leave, true)
    return () => document.removeEventListener('pointerdown', leave, true)
  }, [live, maximised])

  const tile = tileAction(embed, onAction, flash, () => setMaximised(false))
  const name = fileName(embed.path ?? embed.src)
  const title = alt || name
  const folder = embed.path ? resourceDirectory(embed.path, cwd) : undefined
  const detail = maximised ? 'maximised in chat' : [alt && alt !== name ? name : undefined, folder].filter(Boolean).join(' · ')
  const actions: ChatBlockAction[] = maximised ? [
    ...(tile ? [
      { key: 'tile', label: 'Move to tile', text: 'Move to tile', icon: PanelTop, onSelect: () => void tile() },
      { key: 'review', label: 'Review in a tile', text: 'Review', icon: PenLine, onSelect: () => void tile({ engine: 'chromium' }) },
    ] : []),
    { key: 'restore', label: 'Restore (Esc)', text: 'Restore', icon: Minimize2, onSelect: () => setMaximised(false) },
  ] : [
    { key: 'size', label: tall ? 'Shorter' : 'Taller', icon: tall ? FoldVertical : UnfoldVertical, pressed: tall, onSelect: () => setTall((value) => !value) },
    { key: 'maximise', label: 'Maximise', text: 'Maximise', icon: Maximize2, onSelect: () => setMaximised(true) },
    ...(tile ? [{ key: 'tile', label: 'Open as tile', text: 'Tile', icon: PanelTop, onSelect: () => void tile() }] : []),
  ]
  return (
    <span ref={anchor} className="chat-embed-anchor">
      <ChatBlock inline className="chat-embed" title={title} detail={detail || undefined} icon={AppWindow} actions={actions} status={status}
        badge={interactive ? <span className="chat-embed-live">Live</span> : null} label={title}
        maximised={maximised} onMaximisedChange={setMaximised}>
        <span className="chat-embed-stage" style={{ '--chat-embed-height': `${tall ? TALL_EMBED_HEIGHT : EMBED_HEIGHT}px` } as CSSProperties}>
          <SandboxedFrame url={embed.url!} title={title} interactive={interactive} {...(bridge ? { bridge } : {})} />
          {interactive ? null : (
            <button type="button" className="chat-embed-shield" aria-label={`Interact with ${title}`} onClick={() => setLive(true)}>
              <span>Click to interact</span>
            </button>
          )}
        </span>
      </ChatBlock>
    </span>
  )
}

/** A frame drawn at its own size and scaled to fit `box` (or the thumbnail size). */
function scaled(frame: ChatReplyEmbedFrame, box?: { width: number; height: number }) {
  const w = frame.w ?? 390
  const h = frame.h ?? 844
  const scale = box ? Math.min(1, box.width / w, box.height / h) : Math.min(THUMB_HEIGHT / h, THUMB_MAX_WIDTH / w)
  return { scale, width: Math.round(w * scale), height: Math.round(h * scale), frame: { width: w, height: h, transform: `scale(${scale})` } }
}

function CanvasStage({ frame, bridge }: { frame: ChatReplyEmbedFrame; bridge?: EmbedBridge }) {
  const stage = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<{ width: number; height: number }>()
  useLayoutEffect(() => {
    const node = stage.current
    if (!node) return
    const measure = () => setBox({ width: node.clientWidth - 32, height: node.clientHeight - 32 })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])
  const size = box && box.width > 0 && box.height > 0 ? scaled(frame, box) : undefined
  return (
    <span ref={stage} className="chat-embed-canvas-stage">
      {size ? (
        <span className="chat-embed-canvas-screen" style={{ width: size.width, height: size.height }}>
          <SandboxedFrame key={frame.url} url={frame.url} title={frame.title} interactive style={size.frame} {...(bridge ? { bridge } : {})} />
        </span>
      ) : null}
    </span>
  )
}

function CanvasEmbed({ embed, alt, onAction, bridge }: Props & { url: string }) {
  const frames = embed.frames ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [status, flash] = useTransientStatus()
  const anchor = useRef<HTMLSpanElement>(null)
  const maximised = selected !== null
  useChatPaneOverlay(anchor, maximised)
  const tile = tileAction(embed, onAction, flash, () => setSelected(null))
  const title = alt || embed.title || 'Canvas'
  const current = frames.find((frame) => frame.id === selected) ?? frames[0]
  const count = `${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`
  const maximise = (id: string) => setSelected(id)
  const actions: ChatBlockAction[] = maximised ? [
    ...(tile ? [
      { key: 'tile', label: 'Move to tile', text: 'Move to tile', icon: PanelTop, onSelect: () => void tile() },
      // A canvas tile carries its own comment tool, so review happens there.
      { key: 'review', label: 'Review in a canvas tile', text: 'Review', icon: PenLine, onSelect: () => void tile() },
    ] : []),
    { key: 'restore', label: 'Restore (Esc)', text: 'Restore', icon: Minimize2, onSelect: () => setSelected(null) },
  ] : [
    ...(frames.length ? [{ key: 'maximise', label: 'Maximise', text: 'Maximise', icon: Maximize2, onSelect: () => maximise(frames[0].id) }] : []),
    ...(tile ? [
      { key: 'tile', label: 'Open as tile', text: 'Tile', icon: PanelTop, onSelect: () => void tile() },
      { key: 'review', label: 'Review in a canvas tile', text: 'Review', icon: PenLine, onSelect: () => void tile() },
    ] : []),
  ]
  return (
    <span ref={anchor} className="chat-embed-anchor">
      <ChatBlock inline className="chat-embed chat-embed-canvas" title={title} detail={maximised && current ? `${count} · ${current.title}` : count} icon={LayoutGrid}
        actions={actions} status={status} label={title} maximised={maximised} onMaximisedChange={(value) => { if (!value) setSelected(null) }}>
        {maximised && current ? (
          <>
            <span className="chat-embed-tabs" role="tablist" aria-label={`${title} frames`}>
              {frames.map((frame, index) => (
                <button key={frame.id} type="button" role="tab" aria-selected={frame.id === current.id} className="chat-embed-tab" onClick={() => setSelected(frame.id)}>
                  <span className="chat-embed-frame-number">{index + 1}</span>{frame.title}
                </button>
              ))}
            </span>
            <CanvasStage frame={current} {...(bridge ? { bridge } : {})} />
          </>
        ) : frames.length ? (
          <span className="chat-embed-strip">
            {frames.map((frame, index) => {
              const thumb = scaled(frame)
              return (
                <span key={frame.url + frame.id} className="chat-embed-thumb">
                  <span className="chat-embed-thumb-view" style={{ width: thumb.width, height: thumb.height }}>
                    <SandboxedFrame url={frame.url} title={`Preview: ${frame.title}`} interactive={false} style={thumb.frame} preview />
                  </span>
                  <button type="button" className="chat-embed-thumb-caption" aria-label={`Open frame ${index + 1}: ${frame.title}`} onClick={() => maximise(frame.id)}>
                    <span className="chat-embed-frame-number">{index + 1}</span><span className="chat-embed-thumb-title">{frame.title}</span>
                  </button>
                </span>
              )
            })}
          </span>
        ) : <span className="chat-embed-empty">This board has no frames yet</span>}
      </ChatBlock>
    </span>
  )
}

/**
 * Where an embed can't show as a frame: a chip, as for any file the reply
 * names. A page that breaks the folder rule opens in the browser; on another
 * host or a missing file the chip copies the path.
 */
function EmbedChip({ embed, alt, onAction }: Props) {
  const path = embed.path
  if (!path) return <code>{embed.src}</code>
  const resource: ChatReplyResource = embed.error === 'missing'
    ? { ref: embed.src, path, missing: true }
    : { ref: embed.src, path, kind: embed.kind === 'canvas' && !/\.json$/i.test(path) ? 'folder' : 'file' }
  const reason = embed.error === 'not-embeddable' ? 'Only mock-ups in a .canvas, .redline or .pr folder inside this chat’s folder show inline'
    : embed.error === 'invalid' ? "This canvas manifest can't be read"
      : embed.error ? undefined : 'Mock-ups show inline on this Mac only for now'
  return (
    <ResourceChip resource={resource} onAction={onAction} primary="open" {...(reason ? { title: `${path}\n${reason}` } : {})}>
      {alt || fileName(path)}
    </ResourceChip>
  )
}

/**
 * An HTML mock-up or canvas board in a reply (shared/agent-chat.ts
 * `ChatReplyEmbed`). Frames are keyed by URL and memoised on the embed's
 * contents, so a streaming reply re-rendering around them never reloads one.
 */
export const EmbedFrame = memo(function EmbedFrame(props: Props) {
  const { local } = useHost()
  const { embed } = props
  if (!local || embed.error || !embed.url) return <EmbedChip {...props} />
  return embed.kind === 'canvas' ? <CanvasEmbed key={embed.url} {...props} url={embed.url} /> : <HtmlEmbed key={embed.url} {...props} url={embed.url} />
}, (previous, next) => previous.alt === next.alt && previous.cwd === next.cwd && previous.onAction === next.onAction &&
  previous.bridge === next.bridge && JSON.stringify(previous.embed) === JSON.stringify(next.embed))
