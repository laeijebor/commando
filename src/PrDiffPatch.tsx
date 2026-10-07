import { useEffect, useRef, useState } from 'react'
import { AnsiText } from './AnsiText'
import type { PrsApiClient } from './prsApi'

/** Uses the same Delta/ANSI pipeline as the worktree viewer, with GitHub's pinned patch. */
export function PrDiffPatch({ path, patch, api }: { path: string; patch: string; api: PrsApiClient }) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(120)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ width: number; ansi?: string; error?: string } | null>(null)

  useEffect(() => {
    const node = container.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const font = getComputedStyle(node)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context) context.font = `${font.fontSize} ${font.fontFamily}`
      const cellWidth = context?.measureText('M').width || 7.2
      setWidth(Math.min(500, Math.max(60, Math.floor((node.clientWidth - 32) / cellWidth))))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    setResult(null)
    const timeout = window.setTimeout(() => {
      api.renderDiff(path, patch, width).then(
        (ansi) => { if (active) setResult({ width, ansi }) },
        (error: unknown) => { if (active) setResult({ width, error: error instanceof Error ? error.message : 'Unable to render Delta diff' }) },
      )
    }, 100)
    return () => { active = false; window.clearTimeout(timeout) }
  }, [api, path, patch, width, retry])

  const current = result?.width === width ? result : null
  return (
    <div ref={container} className="pr-delta-patch">
      {current?.ansi !== undefined ? (
        <pre className="pr-delta-output" aria-label="Delta syntax-highlighted diff"><AnsiText text={current.ansi} /></pre>
      ) : (
        <>
          <p className="pr-delta-notice" role="status">
            {current?.error ? `${current.error} Showing the plain patch.` : 'Rendering with Delta…'}
            {current?.error ? <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry highlighting</button> : null}
          </p>
          <pre>{patch.split('\n').map((line, index) => (
            <span key={index} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : undefined}>
              {line || ' '}
            </span>
          ))}</pre>
        </>
      )}
    </div>
  )
}
