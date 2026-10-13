import { Check, Copy, Flag, MessageSquare, RotateCcw, Send, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { parseGuide, stripGuideStepId, type GuideSnapshot, type GuideStep } from '../shared/guide'
import { createGuideApi } from './guideApi'
import { subscribeCanvasChanges, subscribeGuideStates } from './webPanesApi'
import './guide-pane.css'

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'checkpoint', 'callout'],
  attributes: {
    ...defaultSchema.attributes,
    checkpoint: ['id', 'done'],
    callout: ['tone', 'title'],
    li: [...(defaultSchema.attributes?.li ?? []), 'dataStepOffset'],
  },
}
const CLOBBER_PREFIX = 'user-content-'
const TONES = new Set(['info', 'warn', 'danger', 'success'])

type StepView = GuideStep & { checked: boolean; note?: string }
type GuideContextValue = {
  byOffset: Map<number, StepView>
  byId: Map<string, StepView>
  busy: ReadonlySet<string>
  toggle: (step: StepView) => void
  saveNote: (step: StepView, note: string) => void
}
const GuideContext = createContext<GuideContextValue | null>(null)

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[]; properties?: Record<string, unknown>; position?: { start: { offset?: number } } }

/** Stamp task items with their Markdown offset before raw HTML parsing and sanitizing drop positions. */
function rehypeStepOffsets() {
  const visit = (node: HastNode) => {
    if (node.tagName === 'li' && node.position?.start.offset !== undefined) node.properties = { ...node.properties, dataStepOffset: String(node.position.start.offset) }
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: HastNode) => visit(tree)
}

/** Drop the `{#id}` suffix from the end of each task item's first paragraph (where parseGuide reads it). */
function rehypeStripStepIds() {
  const lastText = (nodes: HastNode[]): HastNode | undefined => {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node.type === 'text' && node.value?.trim()) return node
      if (node.type === 'element') return lastText(node.children ?? [])
    }
  }
  const visit = (node: HastNode) => {
    if (node.tagName === 'li') {
      const children = node.children ?? []
      const block = children.findIndex((child) => child.type === 'element' && ['p', 'ul', 'ol', 'pre', 'div', 'blockquote', 'table'].includes(child.tagName!))
      const leading = children.slice(0, block < 0 ? children.length : block)
      const text = leading.some((child) => child.type === 'text' && child.value?.trim()) || block < 0 || children[block].tagName !== 'p'
        ? lastText(leading)
        : lastText(children[block].children ?? [])
      if (text?.value) text.value = stripGuideStepId(text.value)
    }
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: HastNode) => visit(tree)
}

function StepNote({ step }: { step: StepView }) {
  const guide = useContext(GuideContext)!
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(step.note ?? '')
  useEffect(() => { if (!editing) setDraft(step.note ?? '') }, [editing, step.note])
  const save = () => { setEditing(false); if (draft.trim() !== (step.note ?? '')) guide.saveNote(step, draft) }
  if (editing) return (
    <textarea className="guide-note-input" autoFocus value={draft} rows={2} maxLength={2_000}
      aria-label={`Note for ${step.label}`} placeholder="What happened? (sent with the next update)"
      onChange={(event) => setDraft(event.target.value)} onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save() }
        if (event.key === 'Escape') { setDraft(step.note ?? ''); setEditing(false) }
      }} />
  )
  return step.note
    ? <button type="button" className="guide-note" onClick={() => setEditing(true)} title="Edit note">{step.note}</button>
    : <button type="button" className="guide-note-add" onClick={() => setEditing(true)} aria-label={`Add a note to ${step.label}`} title="Add a note"><MessageSquare aria-hidden="true" /></button>
}

function StepBox({ step }: { step: StepView }) {
  const guide = useContext(GuideContext)!
  return (
    <input type="checkbox" className="guide-box" checked={step.checked} disabled={guide.busy.has(step.id)}
      aria-label={step.label} onChange={() => guide.toggle(step)} />
  )
}

function TaskItem({ node, children, className }: { node?: HastNode; children?: ReactNode; className?: string }) {
  const guide = useContext(GuideContext)
  const offset = Number(node?.properties?.dataStepOffset)
  const step = Number.isInteger(offset) ? guide?.byOffset.get(offset) : undefined
  if (!step) return <li className={className}>{children}</li>
  return (
    <li className={`guide-step${step.checked ? ' is-done' : ''}`} data-step-id={step.id}>
      <StepBox step={step} />
      <div className="guide-step-body">
        {children}
        <StepNote step={step} />
      </div>
    </li>
  )
}

function Checkpoint({ id, children }: { id?: string; children?: ReactNode }) {
  const guide = useContext(GuideContext)
  const step = id ? guide?.byId.get(id.startsWith(CLOBBER_PREFIX) ? id.slice(CLOBBER_PREFIX.length) : id) : undefined
  if (!step) return <span className="guide-checkpoint is-unknown">{children}</span>
  return (
    <span className={`guide-checkpoint${step.checked ? ' is-done' : ''}`} data-step-id={step.id}>
      <span className="guide-checkpoint-row">
        <Flag className="guide-checkpoint-flag" aria-hidden="true" />
        <StepBox step={step} />
        <span className="guide-checkpoint-label">{children}</span>
        <StepNote step={step} />
      </span>
    </span>
  )
}

function CodeBlock({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1_500); return () => window.clearTimeout(timer) }, [copied])
  return (
    <div className="guide-code">
      <pre ref={pre} {...props}>{children}</pre>
      <button type="button" className="guide-copy" aria-label="Copy" title="Copy"
        onClick={() => { void navigator.clipboard?.writeText(pre.current?.textContent?.replace(/\n$/, '') ?? '').then(() => setCopied(true)) }}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  )
}

const ago = (at: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'just now'
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export function GuidePane({ webPaneId, token = '', artifactId, file, artifactUrl, onTitle }: {
  webPaneId: string; token?: string; artifactId: string; file: string; artifactUrl?: string; onTitle?: (title: string) => void
}) {
  const api = useMemo(() => createGuideApi(token), [token])
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const sequence = useRef(0)
  const baseUrl = new URL(`/redline/artifacts/${artifactId}/`, artifactUrl ?? window.location.href).toString()
  const fileUrl = baseUrl + file.split('/').map(encodeURIComponent).join('/')

  const loadMarkdown = useCallback(async () => {
    try {
      const response = await fetch(fileUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error(`${file}: could not load (${response.status})`)
      setMarkdown(await response.text()); setLoadError('')
    } catch (reason) { setLoadError(String((reason as Error).message)) }
  }, [file, fileUrl])
  const loadState = useCallback(async () => {
    const request = ++sequence.current
    try {
      const next = await api.load(webPaneId)
      if (request === sequence.current) { setSnapshot(next); setError(next.error ?? '') }
    } catch (reason) { if (request === sequence.current) setError(String((reason as Error).message)) }
  }, [api, webPaneId])
  const accept = useCallback((next: GuideSnapshot) => { ++sequence.current; setSnapshot(next); setError(next.error ?? '') }, [])

  useEffect(() => {
    void loadMarkdown(); void loadState()
    const offChanges = subscribeCanvasChanges(({ artifactId: changed, changed: paths }) => {
      if (changed !== artifactId || !paths.some((path) => path === file || path === '*')) return
      void loadMarkdown(); void loadState()
    })
    const offStates = subscribeGuideStates((change) => { if (change.artifactId === artifactId && change.file === file) void loadState() })
    return () => { offChanges(); offStates() }
  }, [artifactId, file, loadMarkdown, loadState])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])

  const outline = useMemo(() => markdown === null ? null : parseGuide(markdown), [markdown])
  useEffect(() => { if (outline) onTitle?.(outline.title || file.replace(/\.(md|markdown)$/i, '')) }, [file, onTitle, outline])

  const steps = useMemo(() => (outline?.steps ?? []).map((step): StepView => {
    const mark = snapshot?.marks[step.id]
    return { ...step, checked: mark ? mark.checked : step.sourceChecked, ...(mark?.note ? { note: mark.note } : {}) }
  }), [outline, snapshot])

  const run = useCallback(async (id: string, change: () => Promise<GuideSnapshot>) => {
    setBusy((current) => new Set(current).add(id))
    try { accept(await change()) } catch (reason) { setError(String((reason as Error).message)) }
    finally { setBusy((current) => { const next = new Set(current); next.delete(id); return next }) }
  }, [accept])
  const context = useMemo<GuideContextValue>(() => ({
    byOffset: new Map(steps.map((step) => [step.offset, step])),
    byId: new Map(steps.map((step) => [step.id, step])),
    busy,
    toggle: (step) => {
      setSnapshot((current) => current && { ...current, marks: { ...current.marks, [step.id]: { ...current.marks[step.id], checked: !step.checked, at: Date.now() } } })
      void run(step.id, () => api.mark(webPaneId, { id: step.id, checked: !step.checked }))
    },
    saveNote: (step, note) => { void run(step.id, () => api.mark(webPaneId, { id: step.id, note })) },
  }), [api, busy, run, steps, webPaneId])

  const components = useMemo(() => ({
    li: TaskItem,
    input: ({ type, node: _node, ...props }: { type?: string; node?: unknown }) => type === 'checkbox' ? null : <input type={type} {...props} />,
    pre: CodeBlock,
    a: ({ node: _node, ...props }: { node?: unknown }) => <a {...props} target="_blank" rel="noreferrer" />,
    img: ({ node: _node, src, alt, ...props }: { node?: unknown; src?: string; alt?: string }) => {
      let resolved: string | undefined
      try { resolved = src ? new URL(src, baseUrl).toString() : undefined } catch { resolved = undefined }
      return resolved ? <img {...props} src={resolved} alt={alt ?? ''} /> : null
    },
    checkpoint: Checkpoint,
    callout: ({ tone, title, children }: { tone?: string; title?: string; children?: ReactNode }) => (
      <div className={`guide-callout tone-${tone && TONES.has(tone) ? tone : 'info'}`} role="note">
        {title ? <strong className="guide-callout-title">{title}</strong> : null}
        {children}
      </div>
    ),
  }) as Components, [baseUrl])

  const done = steps.filter((step) => step.checked).length
  const changes = snapshot?.changes.length ?? 0
  const waiting = snapshot?.waiting ?? false
  const update = async () => {
    setSending(true)
    try { accept(await (waiting ? api.cancelUpdate(webPaneId) : api.update(webPaneId))) } catch (reason) { setError(String((reason as Error).message)) }
    finally { setSending(false) }
  }
  const reset = async () => {
    if (!window.confirm('Clear your ticks and notes on this guide?')) return
    try { accept(await api.reset(webPaneId)) } catch (reason) { setError(String((reason as Error).message)) }
  }

  return (
    <div className="guide-pane" data-guide-file={file}>
      <header className="guide-toolbar">
        <span className="guide-progress" aria-label={`${done} of ${steps.length} steps done`}>
          <span className="guide-progress-count">{done}/{steps.length}</span>
          <span className="guide-progress-bar"><span style={{ width: steps.length ? `${(done / steps.length) * 100}%` : 0 }} /></span>
        </span>
        <span className="guide-delivery">
          {waiting ? 'Sends when the agent is idle…' : changes ? `${changes} unsent change${changes === 1 ? '' : 's'}` : snapshot?.deliveredAt ? `Agent updated ${ago(snapshot.deliveredAt, now)}` : ''}
        </span>
        <button type="button" className="guide-tool" onClick={() => { void reset() }} title="Clear my ticks and notes" aria-label="Clear my ticks and notes"><RotateCcw aria-hidden="true" /></button>
        <button type="button" className={`guide-update${changes && !waiting ? ' is-ready' : ''}`} disabled={sending || (!changes && !waiting)} onClick={() => { void update() }}>
          {waiting ? <><X aria-hidden="true" /> Cancel</> : <><Send aria-hidden="true" /> Update agent{changes ? ` (${changes})` : ''}</>}
        </button>
      </header>
      {error || loadError ? <div className="guide-error" role="alert">{loadError || error}</div> : null}
      <div className="guide-scroll">
        {markdown === null ? (loadError ? null : <div className="guide-loading">Loading guide…</div>) : (
          <GuideContext.Provider value={context}>
            <article className="guide-doc">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeStepOffsets, rehypeRaw, [rehypeSanitize, SCHEMA], rehypeStripStepIds]} components={components}>
                {markdown}
              </ReactMarkdown>
            </article>
          </GuideContext.Provider>
        )}
      </div>
    </div>
  )
}
