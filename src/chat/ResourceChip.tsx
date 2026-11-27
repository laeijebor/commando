import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Code, Copy, File, Folder, Image, PanelTop, Pencil, FolderOpen, ExternalLink, Presentation } from 'lucide-react'
import type { ChatReplyResource } from '../../shared/agent-chat'
import { useHost } from '../HostContext'
import type { ResourceAction, ResourceActionHandler } from '../paneManagementApi'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from './ui/menu'

export const canTileResource = (path: string) => /\.(?:html?|svg|png|jpe?g|gif|webp|pdf)$/i.test(path)
const imagePath = (path: string) => /\.(?:svg|png|jpe?g|gif|webp|avif|heic|bmp|ico|tiff?)$/i.test(path)
const codePath = (path: string) => /\.(?:[cm]?[jt]sx?|py|rb|go|rs|c|cpp|h|hpp|swift|kt|java|sh|css|scss|less|json|xml|ya?ml|toml|sql|txt|md|markdown|csv|log|ini|conf|env)$/i.test(path)
export function primaryResourceAction(resource: ChatReplyResource): ResourceAction {
  if ('missing' in resource) return 'open'
  if (resource.deck) return 'slides'
  if (resource.kind === 'folder') return 'open'
  return canTileResource(resource.path) ? 'tile' : codePath(resource.path) ? 'editor' : 'open'
}
const actionLabel: Record<ResourceAction, string> = { open: 'Open', tile: 'Open as tile', editor: 'Open in editor', reveal: 'Reveal in Finder', slides: 'Present' }
const deckOf = (resource: ChatReplyResource) => 'deck' in resource ? resource.deck : undefined
const slideCount = (slides: number) => `${slides} ${slides === 1 ? 'slide' : 'slides'}`

export function ResourceIcon({ resource }: { resource: ChatReplyResource }) {
  const Icon = deckOf(resource) ? Presentation : 'kind' in resource && resource.kind === 'folder' ? Folder : imagePath(resource.path) ? Image : codePath(resource.path) ? Code : File
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />
}

/** Shared by inline references, cards and work-log actions. */
export function useResourceActions(onAction?: ResourceActionHandler) {
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  const run = async (resource: ChatReplyResource, requested: MenuAction) => {
    if (busy) return
    setBusy(true)
    try {
      if (requested === 'copy') await navigator.clipboard.writeText(resource.path)
      else {
        if (!onAction) throw new Error('Resource actions are unavailable')
        // A deck's folder, whether the reply named the folder or a page in it.
        const action = requested === 'open-folder' ? 'open' : requested
        const path = requested === 'open-folder' ? deckOf(resource)?.folder ?? resource.path : resource.path
        const result = await onAction(path, action, requested !== 'open-folder' && 'line' in resource ? resource.line : undefined)
        if (mounted.current && result.performed !== action) setNotice(`${actionLabel[result.performed]} instead`)
      }
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally { if (mounted.current) setBusy(false) }
  }
  return { run, notice, busy }
}

type MenuAction = ResourceAction | 'copy' | 'open-folder'
function ResourceActions({ resource, run, disabled, local }: {
  resource: ChatReplyResource; run: (action: MenuAction) => void; disabled: boolean; local: boolean
}) {
  const file = 'kind' in resource && resource.kind === 'file'
  const deck = deckOf(resource)
  return <MenuPopup>
    {local && deck ? <>
      <MenuItem disabled={disabled} onClick={() => run('slides')}><Presentation />Present</MenuItem>
      <MenuItem disabled={disabled} onClick={() => run('open-folder')}><FolderOpen />Open folder</MenuItem>
    </> : local && !('missing' in resource) ? <>
      <MenuItem disabled={disabled} onClick={() => run('open')}><FolderOpen />Open</MenuItem>
      {file && canTileResource(resource.path) ? <MenuItem disabled={disabled} onClick={() => run('tile')}><PanelTop />Open as tile</MenuItem> : null}
      {file ? <MenuItem disabled={disabled} onClick={() => run('editor')}><Pencil />Open in editor</MenuItem> : null}
      <MenuItem disabled={disabled} onClick={() => run('reveal')}><FolderOpen />Reveal in Finder</MenuItem>
    </> : null}
    <MenuItem disabled={disabled} onClick={() => run('copy')}><Copy />Copy path</MenuItem>
  </MenuPopup>
}

export function ResourceChip({ resource, children, onAction }: { resource: ChatReplyResource; children: ReactNode; onAction?: ResourceActionHandler }) {
  const { local } = useHost()
  const { run, notice, busy } = useResourceActions(onAction)
  const [menu, setMenu] = useState(false)
  const missing = 'missing' in resource
  const deck = deckOf(resource)
  return <span className="chat-resource-inline">
    <span className={`chat-resource-chip border-border bg-card ${missing ? 'chat-resource-missing' : 'text-primary'}`}
      title={missing ? `${resource.path} — not found` : deck ? `${deck.title} · ${slideCount(deck.slides)} — ${resource.path}` : resource.path} onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
      <button type="button" className="chat-resource-label" disabled={busy} onClick={() => void run(resource, local && !missing ? primaryResourceAction(resource) : 'copy')}>
        <ResourceIcon resource={resource} /><span>{children}</span>
        {deck ? <span className="chat-slides-count text-muted-foreground" aria-hidden="true">{slideCount(deck.slides)}</span> : null}
      </button>
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger className="chat-resource-chevron" aria-label="Resource actions"><ChevronDown className="size-3" /></MenuTrigger>
        <ResourceActions resource={resource} local={local} disabled={busy} run={(action) => void run(resource, action)} />
      </Menu>
    </span>
    {notice ? <span role="status" className="chat-resource-notice text-xs text-destructive">{notice}</span> : null}
  </span>
}

export function resourceDirectory(path: string, cwd: string): string {
  const directory = path.slice(0, path.lastIndexOf('/')) || '/'
  const root = cwd.replace(/\/$/, '')
  if (root && (directory === root || directory.startsWith(`${root}/`))) return directory === root ? '.' : directory.slice(root.length + 1)
  return directory.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}
function resourceMeta(resource: ChatReplyResource): string {
  if ('missing' in resource) return 'Not found'
  if (resource.kind === 'folder') return resource.entries === undefined ? 'Folder' : `${resource.entries} items`
  const size = resource.size
  const bytes = size === undefined ? '' : size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`
  const seconds = Math.max(0, (Date.now() - (resource.mtimeMs ?? Date.now())) / 1000)
  const age = seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`
  return [bytes, resource.mtimeMs === undefined ? '' : age].filter(Boolean).join(' · ')
}
/** Keep rich descriptions inline, trimming a separator from their first text node. */
export function cardDescription(description: ReactNode): { content: ReactNode; hasContent: boolean } {
  let firstText = true
  let hasContent = false
  const inline = (nodes: ReactNode): ReactNode => Children.map(nodes, (child) => {
    if (typeof child === 'string') {
      const text = firstText ? child.replace(/^\s*[—–:-]\s*/, '') : child
      if (child.trim()) firstText = false
      if (text.trim()) hasContent = true
      return text
    }
    if (typeof child === 'number') { firstText = false; hasContent = true }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    const children = inline(child.props.children)
    return child.type === 'p' ? <span key={child.key}>{children}</span> : cloneElement(child, {}, children)
  })
  const content = inline(description)
  return { content, hasContent }
}

export type ResourceCardRow = { resource: ChatReplyResource; description?: ReactNode }
export function ResourceCardList({ rows, cwd, onAction }: { rows: ResourceCardRow[]; cwd: string; onAction?: ResourceActionHandler }) {
  return <div className="chat-resource-cards rounded-lg border border-border bg-card overflow-hidden" role="list">{rows.map((row, index) => <ResourceCard key={`${row.resource.ref}:${index}`} {...row} cwd={cwd} onAction={onAction} />)}</div>
}
function ResourceCard({ resource, description, cwd, onAction }: ResourceCardRow & { cwd: string; onAction?: ResourceActionHandler }) {
  const { local } = useHost()
  const { run, notice, busy } = useResourceActions(onAction)
  const missing = 'missing' in resource
  const primary = primaryResourceAction(resource)
  const [menu, setMenu] = useState(false)
  const deck = deckOf(resource)
  const ActionIcon = deck ? Presentation : !missing && resource.kind === 'folder' ? FolderOpen : primary === 'tile' ? PanelTop : primary === 'editor' ? Code : ExternalLink
  const detail = cardDescription(description)
  return <div role="listitem" className="chat-resource-card px-2.5 py-2 hover:bg-secondary" onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <span className="chat-resource-icon-tile rounded-md border border-border bg-secondary text-primary"><ResourceIcon resource={resource} /></span>
    <div className="chat-resource-card-content min-w-0 flex-1">
      <div className="chat-resource-title truncate" title={missing ? `${resource.path} — not found` : resource.path}>
        {deck ? <span className="font-medium text-foreground">{deck.title}</span>
          : <span className={`font-mono text-foreground ${missing ? 'chat-resource-missing' : ''}`}>{resource.path.split('/').filter(Boolean).at(-1) || '/'}</span>}
        {detail.hasContent ? <><span className="text-muted-foreground"> · </span><span className="chat-resource-description text-muted-foreground">{detail.content}</span></> : null}
      </div>
      {deck ? <div className="chat-resource-directory chat-slides-first truncate text-muted-foreground" title={resource.path}>
        <span className="chat-slides-first-number rounded-sm border border-border bg-secondary font-mono" aria-label="Slide 1">1</span>
        <span>{deck.first ?? 'Slide 1'}</span>
      </div>
        : <div className="chat-resource-directory truncate font-mono text-muted-foreground" title={resource.path}>{resourceDirectory(resource.path, cwd)}</div>}
      {notice ? <div role="status" className="text-xs text-destructive">{notice}</div> : null}
    </div>
    <span className="chat-resource-meta text-2xs text-muted-foreground">{deck ? slideCount(deck.slides) : resourceMeta(resource)}</span>
    <div className="chat-resource-card-actions">
      {local && !missing ? <button type="button" disabled={busy} className="chat-resource-primary rounded-md border border-input bg-popover px-2 text-xs" onClick={() => void run(resource, primary)}><ActionIcon className="size-3.5" aria-hidden="true" />{actionLabel[primary]}</button> : null}
      <button type="button" className="chat-resource-ghost" disabled={busy} title="Copy path" aria-label="Copy path" onClick={() => void run(resource, 'copy')}><Copy className="size-3.5" aria-hidden="true" /></button>
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger className="chat-resource-ghost" aria-label="Resource actions"><ChevronDown className="size-3" aria-hidden="true" /></MenuTrigger>
        <ResourceActions resource={resource} local={local} disabled={busy} run={(action) => void run(resource, action)} />
      </Menu>
    </div>
  </div>
}
