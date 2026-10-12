import { encodeCanvasPath } from '../shared/canvas-manifest'
import { canvasRequest } from './canvasWrite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFrame } from '../shared/canvas-manifest'

export function CanvasFrameExport({ frame, baseUrl, apiUrl, manifest, token, snapshot = false, anchor, overlay, onClose }: {
  frame: CanvasFrame; baseUrl: string; apiUrl: string; manifest: string; token: string; snapshot?: boolean
  anchor: HTMLElement; overlay: HTMLElement; onClose: () => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const node = menu.current!
    const bounds = overlay.getBoundingClientRect(), trigger = anchor.getBoundingClientRect()
    const width = node.offsetWidth, height = node.offsetHeight
    const left = Math.max(8, Math.min(trigger.left - bounds.left, overlay.clientWidth - width - 8))
    const below = trigger.bottom - bounds.top + 4
    const top = Math.max(8, Math.min(below + height <= overlay.clientHeight - 8 ? below : trigger.top - bounds.top - height - 4, overlay.clientHeight - height - 8))
    setPosition({ left, top })
  }, [anchor, overlay, error, busy])
  useLayoutEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [anchor])
  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchor.contains(event.target)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        if (anchor.isConnected) (anchor.matches('button') ? anchor : anchor.querySelector<HTMLButtonElement>('.canvas-o-export'))?.focus()
      }
    }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) onClose() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('click', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('click', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [anchor, onClose])
  const fileUrl = baseUrl + encodeCanvasPath(frame.src)
  // Frame files live on the daemon's origin, where <a download> is ignored, so both
  // exports go through a blob URL.
  const save = async (url: string, init: RequestInit, filename: string, failure: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const response = await canvasRequest(url, url === fileUrl ? undefined : token, init, failure)
      const blobUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = blobUrl; link.download = filename; link.click()
      // Let the browser start consuming the blob before releasing its URL.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000)
      onClose()
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const downloadHtml = () => save(fileUrl, { cache: 'no-store' }, frame.src.split('/').at(-1)!, 'HTML export failed')
  const downloadPng = () => save(`${apiUrl}/${encodeURIComponent(frame.id)}.png?${new URLSearchParams({ manifest })}`,
    {}, `${frame.id}.png`, 'PNG export failed')
  return <div ref={menu} className="canvas-menu-items canvas-export-popover" style={position} role="menu" aria-label={`Export ${frame.title}`}
    onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" role="menuitem" disabled={busy} onClick={() => void downloadHtml()}>Download HTML</button>
    <button type="button" role="menuitem" disabled={busy || snapshot} title={snapshot ? 'PNG export is available in Live' : undefined} onClick={() => void downloadPng()}>{busy ? 'Rendering PNG…' : 'Download PNG'}</button>
    {error && <span role="alert">{error}</span>}
  </div>
}
