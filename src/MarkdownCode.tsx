import { useEffect, useId, useState, type ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import './markdown-code.css'

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] }

function textOf(node: HastNode): string {
  return node.value ?? node.children?.map(textOf).join('') ?? ''
}

function fenceLanguage(node: HastNode | undefined): string | undefined {
  const code = node?.children?.find((child) => child.tagName === 'code')
  const classes = code?.properties?.className
  const language = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-')) : undefined
  return language ? String(language).slice('language-'.length) : undefined
}

let mermaidLoader: Promise<typeof import('mermaid').default> | undefined

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', suppressErrorRendering: true })
    return mermaid
  })
  return mermaidLoader
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const [svg, setSvg] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg }) => { if (!cancelled) setSvg(svg) })
      .catch(() => { if (!cancelled) { setSvg(undefined); setFailed(true) } })
    return () => { cancelled = true }
  }, [id, source])
  if (svg) return <div className="markdown-mermaid" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
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

/** `pre` override for react-markdown: renders ```mermaid fences as diagrams and colours ```diff fences. */
export function MarkdownPre({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const hast = node as HastNode | undefined
  const language = fenceLanguage(hast)
  if (hast && language === 'mermaid') return <MermaidDiagram source={textOf(hast).trimEnd()} />
  if (hast && language === 'diff') return <DiffBlock source={textOf(hast).replace(/\n$/, '')} />
  return <pre {...props} />
}
