import { RadioTower } from 'lucide-react'
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
  const groups = sessions.flatMap((session) => {
    const sessionPorts = ports
      .filter((port) => port.sessionId === session.id)
      .sort((left, right) => left.port - right.port)
    return sessionPorts.length ? [{ session, ports: sessionPorts }] : []
  })
  const portCount = groups.reduce((count, group) => count + group.ports.length, 0)
  if (portCount === 0) return null

  return (
    <section className="sidebar-ports" aria-labelledby="sidebar-ports-title">
      <header>
        <span><RadioTower aria-hidden="true" /><h2 id="sidebar-ports-title">Ports</h2></span>
        <small>{portCount}</small>
      </header>
      <div className="sidebar-port-groups">
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
