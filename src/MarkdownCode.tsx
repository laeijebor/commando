import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import { DiagramBlock, PrDiagramFence, standaloneSvg } from './chat/DiagramBlock'
import { documentMermaidThemeVariables, useThemeName } from './mermaidTheme'
import './markdown-code.css'

export type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] }

export function textOf(node: HastNode): string {
  return node.value ?? node.children?.map(textOf).join('') ?? ''
}

export function fenceLanguage(node: HastNode | undefined): string | undefined {
  const code = node?.children?.find((child) => child.tagName === 'code')
  const classes = code?.properties?.className
  const language = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-')) : undefined
  return language ? String(language).slice('language-'.length) : undefined
}

const RENDER_DELAY_MS = 150

let mermaidLoader: Promise<typeof import('mermaid').default> | undefined

/** Mermaid, configured for the current theme: called before each render, so a theme change takes effect. */
function loadMermaid() {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => mermaid)
  return mermaidLoader.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false, theme: 'base', themeVariables: documentMermaidThemeVariables(),
      securityLevel: 'strict', suppressErrorRendering: true,
      // Mermaid defaults to 16px text (and sequence diagrams to 150px actors), larger than the chat around it.
      fontSize: 13,
      sequence: { width: 120, height: 40, actorMargin: 40, boxMargin: 8, diagramMarginX: 16, diagramMarginY: 8 },
    })
    return mermaid
  })
}

/** "sequenceDiagram" reads as "Sequence diagram"; the caption names the kind of diagram. */
function mermaidKind(source: string): string {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*%%.*$/gm, '').trim()
  const word = /^[A-Za-z-]+/.exec(body)?.[0] ?? ''
  const name = word.replace(/-?(?:beta|v2)$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^graph$/i, 'flowchart').toLowerCase()
  return name ? name[0].toUpperCase() + name.slice(1) : 'Diagram'
}

export function MermaidDiagram({ source }: { source: string }) {
  const baseId = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const renders = useRef(0)
  const picture = useRef<HTMLDivElement>(null)
  const theme = useThemeName()
  const [svg, setSvg] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Debounced so streamed chat text doesn't queue a render per token, and a
    // fresh id each time because mermaid first removes any element with the
    // id it is given — which would be the diagram on screen.
    const timer = setTimeout(() => {
      const id = `${baseId}-${renders.current++}`
      loadMermaid()
        .then((mermaid) => mermaid.render(id, source))
        .then(({ svg }) => { if (!cancelled) { setSvg(svg); setFailed(false) } })
        .catch(() => { if (!cancelled) setFailed(true) })
    }, RENDER_DELAY_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [baseId, source, theme])
  // Never wider than drawn: a small diagram stays its size, centred, and still shrinks in a narrow pane.
  useLayoutEffect(() => {
    const element = picture.current?.querySelector('svg')
    const width = Number(element?.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2])
    if (element && width > 0) element.style.maxWidth = `${Math.ceil(width)}px`
  }, [svg])
  // A half-streamed source often fails to parse; keep the last good diagram.
  if (svg) {
    const read = () => {
      const element = picture.current?.querySelector('svg')
      return element ? standaloneSvg(element) : null
    }
    return (
      <DiagramBlock title={mermaidKind(source)} detail="mermaid" source={source} svg={read}>
        <div ref={picture} className="markdown-mermaid" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      </DiagramBlock>
    )
  }
  return (
    <div className="markdown-mermaid-fallback">
      {failed ? <small>Couldn't render this Mermaid diagram.</small> : null}
      <pre><code>{source}</code></pre>
    </div>
  )
}

function diffLineClass(line: string) {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@@')) return 'hunk'
  return undefined
}

/** Colours a fenced `diff` block line by line, like GitHub. */
function DiffBlock({ source }: { source: string }) {
  return (
    <pre className="markdown-diff">
      <code>
        {source.split('\n').map((line, index) => (
          <span key={index} className={diffLineClass(line)}>{line}{'\n'}</span>
        ))}
      </code>
    </pre>
  )
}

/** `pre` override for react-markdown: renders ```mermaid and ```pr-diagram fences as diagrams and colours ```diff fences. */
export function MarkdownPre({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const hast = node as HastNode | undefined
  const language = fenceLanguage(hast)
  if (hast && language === 'mermaid') return <MermaidDiagram source={textOf(hast).trimEnd()} />
  if (hast && language === 'diff') return <DiffBlock source={textOf(hast).replace(/\n$/, '')} />
  if (hast && language === 'pr-diagram') return <PrDiagramFence source={textOf(hast).replace(/\n$/, '')} fallback={<pre {...props} />} />
  return <pre {...props} />
}
