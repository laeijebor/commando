import { createContext, use, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Copy, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, PanelRight } from 'lucide-react'
import type { GithubPrLink, LinearChipIssue, LinearIssueLink, PrChipState, PrChipSummary, PrLinkTab, RichLink } from '../../shared/rich-links'
import { cardDescription } from './ResourceChip'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './ui/menu'

/** What PR and Linear chips can ask of the app; each part is optional, and a chip shows only the link without it. */
export type RichLinkServices = {
  prSummary?: (repo: string, number: number) => Promise<PrChipSummary | null>
  linearIssue?: (url: string) => Promise<LinearChipIssue | null>
  /** Opens PR Quick Look in the pane's side panel, for a PR `hasQuickLook` accepts. */
  openPr?: (repo: string, number: number, tab: PrLinkTab) => void
  /** Only PRs linked to the pane have a side-panel tab; chips link to GitHub for the rest. */
  hasQuickLook?: (repo: string, number: number) => boolean
}

export const RichLinksContext = createContext<RichLinkServices>({})

/** Opens this PR's Quick Look, when it has one here. */
function useQuickLook(link: RichLink): (() => void) | undefined {
  const { openPr, hasQuickLook } = use(RichLinksContext)
  return link.kind === 'pr' && openPr && hasQuickLook?.(link.repo, link.number) ? () => openPr(link.repo, link.number, link.tab) : undefined
}

type Loaded = { at: number; value?: unknown; failed?: boolean; pending?: Promise<void> }
const LOADED_MS = 2 * 60_000
const FAILED_MS = 30_000
const MAX_LOADED = 300
/** Per loader, so a host switch (new loaders) starts afresh. Chips remount as replies stream; this keeps that to one request. */
const loadedBy = new WeakMap<object, Map<string, Loaded>>()
function entriesFor(loader: object): Map<string, Loaded> {
  let entries = loadedBy.get(loader)
  if (!entries) { entries = new Map(); loadedBy.set(loader, entries) }
  return entries
}
/** Undefined while loading; null when there is nothing to show. A refresh keeps showing the last answer. */
function current<T>(entry: Loaded | undefined): T | null | undefined {
  if (!entry) return undefined
  if (entry.value !== undefined && entry.value !== null) return entry.value as T
  return entry.pending ? undefined : null
}

/** At most this many lookups per loader run at once, so a long chat doesn't start dozens of `gh` reads together. */
const MAX_CONCURRENT_LOADS = 4
const queues = new WeakMap<object, { active: number; waiting: (() => void)[] }>()
export function queued<T>(loader: object, run: () => Promise<T>): Promise<T> {
  let queue = queues.get(loader)
  if (!queue) { queue = { active: 0, waiting: [] }; queues.set(loader, queue) }
  const slots = queue
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      slots.active++
      run().then(resolve, reject).finally(() => {
        slots.active--
        slots.waiting.shift()?.()
      })
    }
    if (slots.active < MAX_CONCURRENT_LOADS) start()
    else slots.waiting.push(start)
  })
}

/**
 * The loader's answer for `key`, cached briefly across chips and remounts. Nothing loads until `enabled`:
 * chips wait until they are near view and their reply has finished, so a half-written address isn't looked up.
 */
export function useLoaded<T>(loader: object | undefined, key: string, load: () => Promise<T | null>, enabled = true): T | null | undefined {
  const [value, setValue] = useState(() => loader ? current<T>(entriesFor(loader).get(key)) : null)
  useEffect(() => {
    if (!loader) { setValue(null); return }
    let active = true
    const entries = entriesFor(loader)
    let entry = entries.get(key)
    if (enabled && (!entry || (!entry.pending && Date.now() - entry.at >= (entry.failed ? FAILED_MS : LOADED_MS)))) {
      const next: Loaded = { at: Date.now(), value: entry?.value }
      next.pending = queued(loader, load).then((loaded) => { next.value = loaded }, () => { next.failed = true }).finally(() => {
        next.at = Date.now()
        next.pending = undefined
      })
      entries.delete(key)
      entries.set(key, next)
      if (entries.size > MAX_LOADED) entries.delete(entries.keys().next().value!)
      entry = next
    }
    const settled = entry
    setValue(current<T>(settled))
    if (settled?.pending) void settled.pending.then(() => { if (active) setValue(current<T>(settled)) })
    return () => { active = false }
    // `load` reads the same key; the loader's identity is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, enabled])
  return value
}

/** One observer per scroll root; chips are watched until they first come within 400px of view. */
const observers = new Map<Element | null, { observer: IntersectionObserver; callbacks: Map<Element, () => void> }>()
function watchNearView(element: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { onNear(); return () => {} }
  // The timeline scrolls inside its own element, which clips what the viewport would see.
  const root = element.closest('[data-testid="chat-timeline"]')
  let watcher = observers.get(root)
  if (!watcher) {
    const callbacks = new Map<Element, () => void>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const callback = callbacks.get(entry.target)
        callbacks.delete(entry.target)
        observer.unobserve(entry.target)
        callback?.()
      }
    }, { root, rootMargin: '400px' })
    watcher = { observer, callbacks }
    observers.set(root, watcher)
  }
  const { observer, callbacks } = watcher
  callbacks.set(element, onNear)
  observer.observe(element)
  return () => {
    callbacks.delete(element)
    observer.unobserve(element)
    if (!callbacks.size) { observer.disconnect(); observers.delete(root) }
  }
}
/** A callback ref, and whether its element has come near view. */
export function useNearView(): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (!node || near) return
    return watchNearView(node, () => setNear(true))
  }, [node, near])
  return [setNode, near]
}

export function usePrSummary(link: GithubPrLink, enabled = true): PrChipSummary | null | undefined {
  const { prSummary } = use(RichLinksContext)
  return useLoaded(prSummary, `${link.repo.toLowerCase()}#${link.number}`, () => prSummary!(link.repo, link.number), enabled)
}
export function useLinearIssue(link: LinearIssueLink, enabled = true): LinearChipIssue | null | undefined {
  const { linearIssue } = use(RichLinksContext)
  return useLoaded(linearIssue, `${link.workspace}/${link.identifier}`, () => linearIssue!(link.url), enabled)
}

/** Opens a web page in a new browser tab, without handing it this window. */
export function openInBrowser(url: string) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) opened.opener = null
}

const stateLabel: Record<PrChipState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }
const PrIcons = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed }
function PrIcon({ state, className = 'size-3.5' }: { state?: PrChipState; className?: string }) {
  const Icon = PrIcons[state ?? 'open']
  return <Icon className={`${className} shrink-0 ${state ? `chat-pr-${state}` : ''}`} aria-hidden="true" />
}
function PrState({ state }: { state: PrChipState }) {
  return <span className={`chat-rich-badge chat-pr-${state}`}>{stateLabel[state]}</span>
}
function LinearState({ state }: { state: NonNullable<LinearChipIssue['state']> }) {
  return <span className="chat-rich-badge chat-linear-state">
    <span className="chat-linear-dot" style={state.color ? { background: state.color } : undefined} aria-hidden="true" />{state.name}
  </span>
}
function LinearIcon({ issue, className = '' }: { issue?: LinearChipIssue | null; className?: string }) {
  return <span className={`chat-linear-dot chat-linear-icon ${className}`} style={issue?.state?.color ? { background: issue.state.color } : undefined} aria-hidden="true" />
}

/** Copies a link and briefly says so. */
function useCopied() {
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [notice])
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setNotice('Link copied'), (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  return { notice, copy }
}

function LinkActions({ link, openPr, copy }: { link: RichLink; openPr?: () => void; copy: (url: string) => void }) {
  return <MenuPopup>
    {openPr ? <MenuItem onClick={openPr}><PanelRight />Open in Quick Look</MenuItem> : null}
    <MenuItem onClick={() => openInBrowser(link.url)}><ExternalLink />{link.kind === 'pr' ? 'Open on GitHub' : 'Open in Linear'}</MenuItem>
    <MenuItem onClick={() => copy(link.url)}><Copy />Copy link</MenuItem>
  </MenuPopup>
}

/** A link's own text, when the agent wrote one rather than the bare address. */
function ownLabel(link: RichLink, label: string | undefined): string | undefined {
  const text = label?.trim()
  if (!text || text === link.url || link.url.replace(/^https:\/\/(?:www\.)?/, '').startsWith(text.replace(/^https?:\/\/(?:www\.)?/, ''))) return undefined
  return text
}

function Chip({ link, icon, name, title, badge, label, viewRef }: { link: RichLink; icon: ReactNode; name: string; title?: string; badge?: ReactNode; label?: string; viewRef: (node: Element | null) => void }) {
  const onOpen = useQuickLook(link)
  const [menu, setMenu] = useState(false)
  const { notice, copy } = useCopied()
  const text = title ?? ownLabel(link, label)
  const content = <>{icon}<span className="chat-rich-name">{name}</span>{text ? <span className="chat-rich-title text-foreground">{text}</span> : null}{badge}</>
  return <span className="chat-resource-inline" ref={viewRef}>
    <span className="chat-resource-chip chat-rich-chip border-border bg-card text-primary" title={text ? `${name} · ${text}` : link.url} onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
      {onOpen ? <button type="button" className="chat-resource-label" onClick={onOpen}>{content}</button>
        : <a className="chat-resource-label" href={link.url} target="_blank" rel="noreferrer">{content}</a>}
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger className="chat-resource-chevron" aria-label="Link actions"><ChevronDown className="size-3" /></MenuTrigger>
        <LinkActions link={link} copy={copy} {...(onOpen ? { openPr: onOpen } : {})} />
      </Menu>
    </span>
    {notice ? <span role="status" className="chat-resource-notice text-xs text-muted-foreground">{notice}</span> : null}
  </span>
}

function PrChip({ link, label, running }: { link: Extract<RichLink, { kind: 'pr' }>; label?: string; running?: boolean }) {
  const [viewRef, near] = useNearView()
  const summary = usePrSummary(link, near && !running)
  return <Chip viewRef={viewRef} link={link} name={`${link.repo}#${link.number}`} label={label} icon={<PrIcon state={summary?.state} />}
    {...(summary ? { title: summary.title, badge: <PrState state={summary.state} /> } : {})} />
}

function LinearChip({ link, label, running }: { link: Extract<RichLink, { kind: 'linear' }>; label?: string; running?: boolean }) {
  const [viewRef, near] = useNearView()
  const issue = useLinearIssue(link, near && !running)
  return <Chip viewRef={viewRef} link={link} name={link.identifier} label={label} icon={<LinearIcon issue={issue} />}
    {...(issue ? { title: issue.title, ...(issue.state ? { badge: <LinearState state={issue.state} /> } : {}) } : {})} />
}

/** An inline GitHub PR or Linear issue link, shown as a chip. While its reply streams the address may be half-written, so nothing loads. */
export function RichLinkChip({ link, label, running }: { link: RichLink; label?: string; running?: boolean }) {
  return link.kind === 'pr' ? <PrChip link={link} label={label} running={running} /> : <LinearChip link={link} label={label} running={running} />
}

export type RichLinkCardRow = { link: RichLink; label?: string; description?: ReactNode }
/** A list where every item starts with a PR or Linear link. */
export function RichLinkCardList({ rows, running }: { rows: RichLinkCardRow[]; running?: boolean }) {
  return <div className="chat-resource-cards rounded-lg border border-border bg-card overflow-hidden" role="list">
    {rows.map((row, index) => row.link.kind === 'pr'
      ? <PrCard key={`${row.link.url}:${index}`} {...row} link={row.link} running={running} />
      : <LinearCard key={`${row.link.url}:${index}`} {...row} link={row.link} running={running} />)}
  </div>
}

function Card({ link, icon, title, detail, meta, description, viewRef }: {
  link: RichLink; icon: ReactNode; title: string; detail: ReactNode; meta?: ReactNode; description?: ReactNode; viewRef: (node: Element | null) => void
}) {
  const onOpen = useQuickLook(link)
  const OpenIcon = onOpen ? PanelRight : ExternalLink
  const openLabel = onOpen ? 'Quick Look' : link.kind === 'pr' ? 'GitHub' : 'Linear'
  const [menu, setMenu] = useState(false)
  const { notice, copy } = useCopied()
  const rest = cardDescription(description)
  return <div ref={viewRef} role="listitem" className="chat-resource-card px-2.5 py-2 hover:bg-secondary" onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <span className="chat-resource-icon-tile rounded-md border border-border bg-secondary text-primary">{icon}</span>
    <div className="chat-resource-card-content min-w-0 flex-1">
      <div className="chat-resource-title truncate" title={title}>
        <span className="font-medium text-foreground">{title}</span>
      </div>
      {/* The agent's note wraps in full, as on file cards. */}
      {rest.hasContent ? <div className="chat-resource-description text-muted-foreground">{rest.content}</div> : null}
      <div className="chat-resource-directory truncate font-mono text-muted-foreground" title={link.url}>{detail}</div>
      {notice ? <div role="status" className="text-xs text-muted-foreground">{notice}</div> : null}
    </div>
    {meta ? <span className="chat-resource-meta text-2xs">{meta}</span> : null}
    <div className="chat-resource-card-actions">
      {onOpen ? <button type="button" className="chat-resource-primary rounded-md border border-input bg-popover px-2 text-xs" onClick={onOpen}><OpenIcon className="size-3.5" aria-hidden="true" />{openLabel}</button>
        : <a className="chat-resource-primary rounded-md border border-input bg-popover px-2 text-xs" href={link.url} target="_blank" rel="noreferrer"><OpenIcon className="size-3.5" aria-hidden="true" />{openLabel}</a>}
      <button type="button" className="chat-resource-ghost" title="Copy link" aria-label="Copy link" onClick={() => copy(link.url)}><Copy className="size-3.5" aria-hidden="true" /></button>
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger className="chat-resource-ghost" aria-label="Link actions"><ChevronDown className="size-3" aria-hidden="true" /></MenuTrigger>
        <LinkActions link={link} copy={copy} {...(onOpen ? { openPr: onOpen } : {})} />
      </Menu>
    </div>
  </div>
}

function PrCard({ link, label, description, running }: RichLinkCardRow & { link: Extract<RichLink, { kind: 'pr' }>; running?: boolean }) {
  const [viewRef, near] = useNearView()
  const summary = usePrSummary(link, near && !running)
  const name = `${link.repo}#${link.number}`
  const by = [summary?.author, summary?.branch].filter(Boolean).join(' · ')
  return <Card viewRef={viewRef} link={link} icon={<PrIcon state={summary?.state} />} title={summary?.title ?? ownLabel(link, label) ?? name}
    detail={<>{name}{by ? <> · {by}</> : null}</>} description={description}
    {...(summary ? { meta: <PrState state={summary.state} /> } : {})} />
}

function LinearCard({ link, label, description, running }: RichLinkCardRow & { link: Extract<RichLink, { kind: 'linear' }>; running?: boolean }) {
  const [viewRef, near] = useNearView()
  const issue = useLinearIssue(link, near && !running)
  return <Card viewRef={viewRef} link={link} icon={<LinearIcon issue={issue} className="chat-linear-icon-large" />} title={issue?.title ?? ownLabel(link, label) ?? link.identifier}
    detail={<>{link.identifier}{issue?.assignee ? <> · {issue.assignee}</> : null}</>} description={description}
    {...(issue?.state ? { meta: <LinearState state={issue.state} /> } : {})} />
}
