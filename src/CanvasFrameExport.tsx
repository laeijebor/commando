import { encodeCanvasPath } from '../shared/canvas-manifest'
import { canvasRequest } from './canvasWrite'
import { useState } from 'react'
import type { CanvasFrame } from '../shared/canvas-manifest'

export function CanvasFrameExport({ frame, baseUrl, apiUrl, manifest, token, snapshot = false }: {
  frame: CanvasFrame; baseUrl: string; apiUrl: string; manifest: string; token: string; snapshot?: boolean
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [open, setOpen] = useState(false)
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
      setOpen(false)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const downloadHtml = () => save(fileUrl, { cache: 'no-store' }, frame.src.split('/').at(-1)!, 'HTML export failed')
  const downloadPng = () => save(`${apiUrl}/${encodeURIComponent(frame.id)}.png?${new URLSearchParams({ manifest })}`,
    {}, `${frame.id}.png`, 'PNG export failed')
  return <details className="canvas-menu canvas-frame-export" open={open} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <summary aria-label={`Export ${frame.title}`} onClick={(event) => { event.preventDefault(); setOpen(!open) }}>⤓</summary>
    {open && <div className="canvas-menu-items" role="menu" aria-label={`Export ${frame.title}`}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => void downloadHtml()}>Download HTML</button>
      <button type="button" role="menuitem" disabled={busy || snapshot} title={snapshot ? 'PNG export is available in Live' : undefined} onClick={() => void downloadPng()}>{busy ? 'Rendering PNG…' : 'Download PNG'}</button>
      {error && <span role="alert">{error}</span>}
    </div>}
  </details>
}
