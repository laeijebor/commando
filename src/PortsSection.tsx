import { ChevronDown, ChevronRight, RadioTower } from 'lucide-react'
import { useState } from 'react'
import type { OpenPort, TmuxSession } from '../shared/protocol'
import './ports-section.css'

type Props = {
  sessions: TmuxSession[]
  ports: OpenPort[]
}

export function openPortUrl(port: number): string {
  const url = new URL('/', window.location.href)
  url.protocol = 'http:'
  url.port = String(port)
  return url.toString()
}

export function PortsSection({ sessions, ports }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const groups = sessions.flatMap((session) => {
    const sessionPorts = ports
      .filter((port) => port.sessionId === session.id)
      .sort((left, right) => left.port - right.port)
    return sessionPorts.length ? [{ session, ports: sessionPorts }] : []
  })
  const portCount = groups.reduce((count, group) => count + group.ports.length, 0)
  if (portCount === 0) return null

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
      <div className="sidebar-port-groups" id="sidebar-port-groups" hidden={collapsed}>
        {groups.map(({ session, ports: sessionPorts }) => (
          <div className="sidebar-port-group" key={session.id}>
            <strong title={session.name}>{session.name}</strong>
            <div aria-label={`Open ports for ${session.name}`}>
              {sessionPorts.map((port) => (
                <a
                  className="sidebar-port-link"
                  href={openPortUrl(port.port)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${port.processName} on port ${port.port}`}
                  title={`${port.processName} listening on port ${port.port}`}
                  key={`${port.paneId}:${port.port}`}
                >
                  {port.port}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
