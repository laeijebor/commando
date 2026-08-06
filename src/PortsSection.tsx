import { ChevronDown, ChevronRight, RadioTower, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import type { OpenPort, TmuxSession } from '../shared/protocol'
import { createPortManagementApi } from './portManagementApi'
import { PortContextMenu } from './PortContextMenu'
import './ports-section.css'

type Props = {
  token: string
  sessions: TmuxSession[]
  ports: OpenPort[]
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onSelectPane: (paneId: string) => void
  onOpenAsTile?: (port: OpenPort) => void
}

export function openPortUrl(port: number): string {
  const url = new URL('/', window.location.href)
  url.protocol = 'http:'
  url.port = String(port)
  return url.toString()
}

export function PortsSection({ token, sessions, ports, selectedSessionId, onSelectSession, onSelectPane, onOpenAsTile }: Props) {
  const api = useRef(createPortManagementApi(token)).current
  const [collapsed, setCollapsed] = useState(false)
  const [menu, setMenu] = useState<{ port: OpenPort; x: number; y: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const groups = sessions.flatMap((session) => {
    const sessionPorts = ports
      .filter((port) => port.sessionId === session.id)
      .sort((left, right) => left.port - right.port)
    return sessionPorts.length ? [{ session, ports: sessionPorts }] : []
  })
  const portCount = groups.reduce((count, group) => count + group.ports.length, 0)
  if (portCount === 0) return null

  const openMenuFromKeyboard = (event: KeyboardEvent<HTMLAnchorElement>, port: OpenPort) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      setMenu({ port, x: bounds.left + 8, y: bounds.bottom })
    }
  }

  const killPort = async (port: OpenPort) => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await api.killPort(port)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to kill process on port ${port.port}`)
    } finally {
      setPending(false)
    }
  }

  const killSessionPorts = async (session: TmuxSession, sessionPorts: OpenPort[]) => {
    const portList = sessionPorts.map((port) => port.port).join(', ')
    if (pending || !window.confirm(`Kill every process listening on port${sessionPorts.length === 1 ? '' : 's'} ${portList} for "${session.name}"? This can stop development servers.`)) return
    setPending(true)
    setError('')
    try {
      await api.killSessionPorts(session.id, sessionPorts)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to kill port processes for ${session.name}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <section className={`sidebar-ports${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="sidebar-ports-title">
      <header>
        <span>
          <button
            type="button"
            className="sidebar-ports-toggle"
            onClick={() => setCollapsed((current) => !current)}
            aria-controls="sidebar-port-groups"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Reopen ports section' : 'Minimize ports section'}
            title={collapsed ? 'Reopen ports section' : 'Minimize ports section'}
          >
            {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
          <RadioTower className="sidebar-ports-icon" aria-hidden="true" />
          <h2 id="sidebar-ports-title">Ports</h2>
        </span>
        <small>{portCount}</small>
      </header>
      {error ? <button type="button" className="sidebar-ports-error" role="alert" onClick={() => setError('')}>{error}</button> : null}
      <div className="sidebar-port-groups" id="sidebar-port-groups" hidden={collapsed}>
        {groups.map(({ session, ports: sessionPorts }) => (
          <div className="sidebar-port-group" key={session.id}>
            <div className="sidebar-port-group-header">
              <button
                type="button"
                className="sidebar-port-session"
                onClick={() => onSelectSession(session.id)}
                aria-label={`Select session ${session.name}`}
                aria-pressed={session.id === selectedSessionId}
                title={`Select session ${session.name}`}
              >
                {session.name}
              </button>
              <button
                type="button"
                className="sidebar-port-kill"
                disabled={pending}
                onClick={() => void killSessionPorts(session, sessionPorts)}
                aria-label={`Kill all port processes for ${session.name}`}
                title={`Kill all port processes for ${session.name}`}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
            <div className="sidebar-port-links" aria-label={`Open ports for ${session.name}`}>
              {sessionPorts.map((port) => (
                <a
                  className="sidebar-port-link"
                  href={openPortUrl(port.port)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Focus pane for ${port.processName} on port ${port.port}`}
                  title={`${port.processName} listening on port ${port.port}. Click to focus its pane; Command-click to open the service. Option-right-click for process actions.`}
                  onClick={(event) => {
                    onSelectPane(port.paneId)
                    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) event.preventDefault()
                  }}
                  onContextMenu={(event) => {
                    if (!event.altKey) return
                    event.preventDefault()
                    setMenu({ port, x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={(event) => openMenuFromKeyboard(event, port)}
                  key={`${port.paneId}:${port.port}`}
                >
                  {port.port}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
      {menu ? (
        <PortContextMenu
          port={menu.port}
          x={menu.x}
          y={menu.y}
          busy={pending}
          onClose={() => setMenu(null)}
          onKill={() => void killPort(menu.port)}
          onOpenAsTile={onOpenAsTile ? () => onOpenAsTile(menu.port) : undefined}
        />
      ) : null}
    </section>
  )
}
