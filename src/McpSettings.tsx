import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ExternalLink, LoaderCircle, X } from 'lucide-react'
import {
  CHAT_MCP_STATUS_LABELS,
  chatMcpScopeLabel,
  groupChatMcpServers,
  type ChatMcpRequest,
  type ChatMcpResult,
  type ChatMcpServer,
  type ChatMcpServerAction,
} from '../shared/chat-mcp'
import { PaletteBack, PanePaletteShell } from './PanePalette'

/** Opens a sign-in page; false when the browser blocked it, so a link shows instead. */
function openInBrowser(url: string): boolean {
  const opened = window.open(url, '_blank')
  if (opened) opened.opener = null
  return Boolean(opened)
}

const POLL_MS = 4000
const OAUTH_TRANSPORTS = new Set(['http', 'sse', 'claudeai-proxy'])

interface ServerActionButton {
  action: ChatMcpServerAction
  label: string
  key: string
}

/** What Claude Code's `/mcp` offers for a server, with the key that runs each. */
export function mcpServerActions(server: ChatMcpServer): ServerActionButton[] {
  const actions: ServerActionButton[] = []
  const oauth = server.status === 'needs-auth' || OAUTH_TRANSPORTS.has(server.transport ?? '')
  if (server.status !== 'disabled' && oauth) {
    actions.push({ action: 'authenticate', label: server.status === 'needs-auth' ? 'Authenticate' : 'Re-authenticate', key: 'a' })
  }
  if (server.status !== 'disabled') actions.push({ action: 'reconnect', label: 'Reconnect', key: 'r' })
  actions.push(server.status === 'disabled' ? { action: 'enable', label: 'Enable', key: 'e' } : { action: 'disable', label: 'Disable', key: 'd' })
  if (server.status !== 'disabled' && server.status !== 'needs-auth' && (server.transport === 'http' || server.transport === 'sse')) {
    actions.push({ action: 'clear_auth', label: 'Clear authentication', key: 'c' })
  }
  return actions
}

function summary(servers: readonly ChatMcpServer[]): string {
  if (!servers.length) return ''
  const counts = new Map<string, number>()
  for (const server of servers) counts.set(server.status, (counts.get(server.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, count]) => `${count} ${CHAT_MCP_STATUS_LABELS[status as ChatMcpServer['status']].toLowerCase()}`).join(' · ')
}

function rowDetail(server: ChatMcpServer): string {
  if (server.status === 'failed' && server.error) return server.error
  const tools = server.status === 'connected' ? `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}` : undefined
  return [tools, server.transport, server.target].filter(Boolean).join(' · ')
}

function StatusDot({ status }: { status: ChatMcpServer['status'] }) {
  return <span className={`mcp-status-dot mcp-status-${status}`} aria-hidden="true" />
}

/** A chat agent's MCP servers, like Claude Code's `/mcp`: a list, then one server's details and actions. */
export function McpSettings({ agentLabel, load, onBack, onClose, openUrl = openInBrowser, pollMs = POLL_MS }: {
  agentLabel: string
  load: (request: ChatMcpRequest) => Promise<ChatMcpResult>
  onBack: () => void
  onClose: () => void
  openUrl?: (url: string) => boolean
  pollMs?: number
}) {
  const [servers, setServers] = useState<ChatMcpServer[] | null>(null)
  /** A failed status read; the last list stays. */
  const [error, setError] = useState<string | null>(null)
  /** A failed action shows on its own server until the next action there. */
  const [actionError, setActionError] = useState<{ server: string; message: string } | null>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)
  const [detail, setDetail] = useState<string | null>(null)
  const [pending, setPending] = useState<{ server: string; action: ChatMcpServerAction } | null>(null)
  /** The sign-in page an authenticate opened (or couldn't). */
  const [signIn, setSignIn] = useState<{ server: string; url: string; opened: boolean } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const live = useRef(true)
  const acting = useRef(false)
  /** When it last opened a sign-in page, which takes the window's focus. */
  const openedAt = useRef(0)
  const open = (url: string) => {
    openedAt.current = Date.now()
    return openUrl(url)
  }
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const apply = useCallback((result: ChatMcpResult) => {
    if (!live.current) return
    // A failed read keeps the last list rather than blanking it.
    if (result.servers.length || !result.error) setServers(result.servers)
    else setServers((current) => current ?? [])
    setError(result.servers.length ? null : result.error ?? null)
  }, [])

  // Status reads keep the list current while sign-ins and reconnects finish in the background.
  useEffect(() => {
    let stopped = false
    const read = () => {
      if (acting.current) return
      void load({ action: 'status' }).then((result) => { if (!stopped && !acting.current) apply(result) })
    }
    read()
    const timer = window.setInterval(read, pollMs)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [load, apply, pollMs])

  const run = async (server: string, action: ChatMcpServerAction) => {
    if (acting.current) return
    acting.current = true
    setPending({ server, action })
    setActionError(null)
    if (action === 'authenticate') setSignIn(null)
    try {
      const result = await load({ action, server })
      apply(result)
      if (live.current && result.error) setActionError({ server, message: result.error })
      if (live.current && result.authUrl) setSignIn({ server, url: result.authUrl, opened: open(result.authUrl) })
    } finally {
      acting.current = false
      if (live.current) setPending(null)
    }
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = (servers ?? []).filter((server) => !needle || `${server.name} ${server.target ?? ''} ${server.scope ?? ''}`.toLowerCase().includes(needle))
    return groupChatMcpServers(matching)
  }, [servers, query])
  const rows = useMemo(() => groups.flatMap((group) => group.servers), [groups])
  const index = Math.min(chosen, Math.max(0, rows.length - 1))
  const selected = detail ? servers?.find((server) => server.name === detail) : undefined

  useEffect(() => {
    if (detail) detailRef.current?.focus()
    else input.current?.focus()
  }, [detail])
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, rows.length])

  const onListKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setChosen((index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter' || (event.key === 'ArrowRight' && !query)) {
      event.preventDefault()
      if (rows[index]) setDetail(rows[index]!.name)
    } else if (event.key === 'Backspace' && !query) {
      event.preventDefault()
      onBack()
    }
  }

  const actions = selected ? mcpServerActions(selected) : []
  const onDetailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      setDetail(null)
      return
    }
    const action = selected && actions.find((entry) => entry.key === event.key.toLowerCase())
    if (action && selected && !(event.target instanceof HTMLButtonElement && event.key === ' ')) {
      event.preventDefault()
      void run(selected.name, action.action)
    }
  }

  const loading = servers === null && !error
  let row = -1
  return (
    <PanePaletteShell label="MCP servers" className="mcp-settings" onClose={onClose} keepOnBlur={() => Date.now() - openedAt.current < 3000}>
      {detail ? (
        <div className="mcp-detail" tabIndex={-1} ref={detailRef} onKeyDown={onDetailKeyDown}>
          <div className="palette-search">
            <PaletteBack onBack={() => setDetail(null)} />
            <div className="mcp-detail-title">
              <strong>{detail}</strong>
              {selected ? <span className={`mcp-status mcp-status-${selected.status}`}><StatusDot status={selected.status} />{CHAT_MCP_STATUS_LABELS[selected.status]}</span> : <span className="mcp-status">Not configured any more</span>}
            </div>
            {pending ? <LoaderCircle className="spin" aria-label="Working" /> : null}
            <button type="button" className="conversation-picker-close" aria-label="Close MCP servers" title="Close" onClick={onClose}><X aria-hidden="true" /></button>
          </div>
          <div className="mcp-detail-body">
            {selected ? (
              <>
                <dl className="mcp-facts">
                  <dt>Scope</dt><dd>{chatMcpScopeLabel(selected.scope)}</dd>
                  {selected.transport ? <><dt>Transport</dt><dd>{selected.transport}</dd></> : null}
                  {selected.target ? <><dt>{selected.transport === 'stdio' ? 'Command' : 'URL'}</dt><dd className="mcp-mono">{selected.target}</dd></> : null}
                  {selected.serverInfo ? <><dt>Server</dt><dd>{selected.serverInfo}</dd></> : null}
                  {selected.error ? <><dt>Error</dt><dd className="mcp-error">{selected.error}</dd></> : null}
                </dl>
                <div className="mcp-actions" role="group" aria-label="Server actions">
                  {actions.map((entry) => (
                    <button type="button" key={entry.action} disabled={pending !== null} onClick={() => void run(selected.name, entry.action)}
                      className={entry.action === 'authenticate' && selected.status === 'needs-auth' ? 'primary' : ''}>
                      {pending?.server === selected.name && pending.action === entry.action ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
                      {entry.label} <kbd>{entry.key.toUpperCase()}</kbd>
                    </button>
                  ))}
                </div>
                {signIn?.server === selected.name && selected.status !== 'connected' ? (
                  <p className="mcp-sign-in" role="status">
                    {signIn.opened ? 'Finish signing in in your browser; this updates once the agent connects.' : 'Open the sign-in page to finish; this updates once the agent connects.'}
                    {' '}<a href={signIn.url} target="_blank" rel="noreferrer" onClick={() => { openedAt.current = Date.now() }}>Open sign-in page <ExternalLink aria-hidden="true" /></a>
                  </p>
                ) : null}
                {actionError?.server === selected.name ? <div className="conversation-picker-error" role="alert">{actionError.message}</div>
                  : error ? <div className="conversation-picker-error" role="alert">{error}</div> : null}
                <div className="mcp-tools">
                  <div className="conversation-picker-group"><span>Tools</span><span>{selected.tools.length}</span></div>
                  {selected.tools.length ? (
                    <ul>
                      {selected.tools.map((tool) => (
                        <li key={tool.name}>
                          <strong className="mcp-mono">{tool.name}</strong>
                          {tool.readOnly ? <span className="mcp-tag">read-only</span> : null}
                          {tool.destructive ? <span className="mcp-tag mcp-tag-danger">destructive</span> : null}
                          {tool.description ? <small>{tool.description}</small> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <div className="palette-empty">{selected.status === 'connected' ? 'This server has no tools.' : 'Tools show once the server connects.'}</div>}
                </div>
              </>
            ) : <div className="palette-empty">{detail} is no longer configured for this agent.</div>}
          </div>
          <footer className="palette-footer">
            {actions.length ? <span>Letter keys run actions</span> : null}
            <span><kbd>Esc</kbd> Back to servers</span>
          </footer>
        </div>
      ) : (
        <>
          <div className="palette-search">
            <PaletteBack onBack={onBack} />
            <input
              ref={input}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setChosen(0) }}
              onKeyDown={onListKeyDown}
              placeholder={`Filter ${agentLabel}'s MCP servers…`}
              aria-label="Filter MCP servers"
              aria-controls="mcp-server-results"
              aria-activedescendant={rows[index] ? `mcp-server-${index}` : undefined}
            />
            {loading || pending ? <LoaderCircle className="spin" aria-label="Loading" /> : null}
            <button type="button" className="conversation-picker-close" aria-label="Close MCP servers" onClick={onClose}><kbd>Esc</kbd></button>
          </div>
          <div className="conversation-picker-filters mcp-summary">
            <span>{servers ? summary(servers) || 'No MCP servers configured' : 'Reading MCP servers…'}</span>
            {error ? <div className="conversation-picker-error" role="alert">{error}</div> : null}
          </div>
          <div className="command-results" id="mcp-server-results" role="listbox" ref={list}>
            {servers && !rows.length ? <div className="palette-empty">{query ? `No server matches "${query}".` : `${agentLabel} has no MCP servers. Add them with \`claude mcp add\` or a .mcp.json file.`}</div> : null}
            {groups.map((group) => (
              <div role="group" aria-label={group.label} key={group.scope}>
                <div className="conversation-picker-group"><span>{group.label}</span><span>{group.servers.length}</span></div>
                {group.servers.map((server) => {
                  row += 1
                  const position = row
                  return (
                    <button
                      type="button"
                      role="option"
                      id={`mcp-server-${position}`}
                      key={`${group.scope}:${server.name}`}
                      aria-selected={position === index}
                      className={position === index ? 'active' : ''}
                      onMouseMove={() => { if (position !== index) setChosen(position) }}
                      onClick={() => setDetail(server.name)}
                    >
                      <span className="command-icon"><StatusDot status={server.status} /></span>
                      <span>
                        <strong>{server.name}</strong>
                        <small>{rowDetail(server)}</small>
                      </span>
                      <span className={`command-kind mcp-status mcp-status-${server.status}`}>{CHAT_MCP_STATUS_LABELS[server.status]}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <footer className="palette-footer">
            <span><kbd>Enter</kbd> Details</span>
            <span><kbd>⌫</kbd> Back</span>
            <span><kbd>Esc</kbd> Close</span>
          </footer>
        </>
      )}
    </PanePaletteShell>
  )
}
