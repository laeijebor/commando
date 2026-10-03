import { useEffect, useRef, useState } from 'react'
import { Copy, X } from 'lucide-react'
import type { SimElement, SimSourceResult } from '../shared/sim-inspector'
import type { SimOrientation } from '../shared/sim-actions'
import { nativeToScreen, screenSize, type ScreenSize } from './simGeometry'

const frameText = (frame: SimElement['frame']) => (['x', 'y', 'width', 'height'] as const).map((key) => `${key}=${Math.round(frame[key] * 10) / 10}`).join(', ')
const location = (item: { file?: string; line?: number }) => item.file ? `${item.file}${item.line !== undefined ? `:${item.line}` : ''}` : ''
export function inspectorCopyText(element: SimElement, source: SimSourceResult | null): string {
  return [`Role: ${element.role ?? ''}`, `Label: ${element.label ?? ''}`, `Identifier: ${element.identifier ?? ''}`,
    `Frame: ${frameText(element.frame)}`, ...(source?.ok ? source.components.map((item) => `${item.name}${location(item) ? ` (${location(item)})` : ''}`) : [])].join('\n')
}
function sourceReason(source: Extract<SimSourceResult, { ok: false }>): string {
  switch (source.reason) {
    case 'no-metro-port': return "No Metro port on this simulator's lease. Declare one with commando-sim update --metro <port>."
    case 'argent-missing': return 'Argent is not installed.'
    case 'not-connected': return `No React Native dev build is attached to Metro${source.port ? ` on port ${source.port}` : ''}.`
    case 'failed': return `Source lookup failed${source.message ? `: ${source.message}` : '.'}`
  }
}

export function SimInspectorBox({ element, size, canvasSize, orientation }: {
  element: SimElement; size: ScreenSize; canvasSize: ScreenSize; orientation: SimOrientation
}) {
  const { x, y, width, height } = element.frame
  const corners = [{ x, y }, { x: x + width, y }, { x, y: y + height }, { x: x + width, y: y + height }]
    .map((point) => nativeToScreen(point, size, orientation))
  const left = Math.min(...corners.map((point) => point.x)), top = Math.min(...corners.map((point) => point.y))
  const right = Math.max(...corners.map((point) => point.x)), bottom = Math.max(...corners.map((point) => point.y))
  return <div className="sim-inspector-overlay" aria-hidden="true" style={screenSize(canvasSize, orientation)}>
    <div className="sim-inspector-box" data-testid="sim-inspector-box" style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` }}>
      <span>{[element.role, element.label || element.identifier].filter(Boolean).join(' · ')}</span>
    </div>
  </div>
}

export function SimInspectorPanel({ element, source, onClose }: { element: SimElement; source: SimSourceResult | null; onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const revision = useRef(0)
  useEffect(() => {
    revision.current++; setCopyStatus('')
    return () => { revision.current++; clearTimeout(timer.current) }
  }, [element, source])
  const copy = async () => {
    const current = revision.current
    try {
      await navigator.clipboard.writeText(inspectorCopyText(element, source))
      if (current !== revision.current) return
      setCopyStatus('Copied'); clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopyStatus(''), 1_500)
    } catch { if (current === revision.current) setCopyStatus('Copy failed') }
  }
  return <aside className="sim-inspector-panel" aria-label="Element inspector">
    <header><strong>Element inspector</strong><button type="button" onClick={() => void copy()} aria-label="Copy element details"><Copy aria-hidden="true" /> Copy</button>
      <button type="button" onClick={onClose} aria-label="Close element inspector"><X aria-hidden="true" /></button></header>
    {copyStatus ? <p role="status">{copyStatus}</p> : null}
    <dl>{([['Role', element.role], ['Label', element.label], ['Identifier', element.identifier], ['Value', element.value], ['Title', element.title], ['Frame', frameText(element.frame)]] as const)
      .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null ? '—' : String(value)}</dd></div>)}</dl>
    {!source ? <p role="status">Loading component source…</p> : !source.ok ? <p>{sourceReason(source)}</p> : <>
      {source.components.length ? <ol>{source.components.map((item, index) => <li key={index}><strong>{item.name}</strong>{location(item) ? <span>{location(item)}</span> : null}</li>)}</ol> : <p>No component source was returned.</p>}
      {source.components[0]?.code ? <pre>{source.components[0].code}</pre> : null}
      {source.raw ? <details><summary>Raw source response</summary><pre>{source.raw}</pre></details> : null}
    </>}
  </aside>
}
