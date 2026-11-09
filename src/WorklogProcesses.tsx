import { Cpu } from 'lucide-react'
import { useState } from 'react'
import type { TrackedProcess } from '../shared/tracked-processes'
import { openPortUrl } from './PortsSection'
import { useTrackedProcesses, type TrackedProcessesApiClient } from './trackedProcessesApi'
import './worklog-processes.css'

/** How long a process has run: `40s`, `12m`, `3h 5m`, `2d 4h`. */
export function processUptime(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function processMemory(rssKb: number): string {
  return rssKb >= 1024 * 1024 ? `${(rssKb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(rssKb / 1024)} MB`
}

type Props = {
  api?: TrackedProcessesApiClient
  targetId?: string
  paneLabel: string
  connected: boolean
  /** Polls only while the panel shows it. */
  visible?: boolean
}

/** The worklog's Processes section: what this pane started that is still running, including detached processes. */
export function WorklogProcesses({ api, targetId, paneLabel, connected, visible = true }: Props) {
  const { processes, error, refresh } = useTrackedProcesses(api, Boolean(targetId) && connected && visible)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const [stopError, setStopError] = useState('')
  const rows = processes?.filter((process) => process.targetId === targetId) ?? []
  // Hidden while there is nothing to show, including when the daemon cannot list processes.
  if (!api || !targetId || !rows.length) return null

  const stop = async (process: TrackedProcess) => {
    setStopping((current) => new Set([...current, process.key]))
    setStopError('')
    try {
      const result = await api.stop([process.key], targetId)
      if (result.failed.length) setStopError(`Could not stop ${process.command}`)
    } catch (cause) {
      setStopError(cause instanceof Error ? cause.message : `Unable to stop ${process.command}`)
    } finally {
      setStopping((current) => new Set([...current].filter((key) => key !== process.key)))
      await refresh()
    }
  }

  return (
    <section className="pane-worklog-processes" aria-label={`Processes for ${paneLabel}`}>
      <header><strong>Processes</strong><small>{rows.length}</small></header>
      {error ? <p className="pane-worklog-processes-error" role="alert">Showing the last list: {error}</p> : null}
      <div className="pane-worklog-reference-list">
        {rows.map((process) => (
          <div className="pane-worklog-reference pane-worklog-process" key={process.key}>
            <span className="pane-worklog-reference-icon"><Cpu aria-hidden="true" /></span>
            <div>
              <strong title={process.fullCommand}>{process.command}</strong>
              <small>
                {[`up ${processUptime(process.startedAt)}`, `pid ${process.pid}`, process.childCount ? `+${process.childCount} child${process.childCount === 1 ? '' : 'ren'}` : '', processMemory(process.rssKb)]
                  .filter(Boolean).join(' · ')}
              </small>
              {process.ports.length || process.detached ? <div className="pane-worklog-process-chips">
                {process.detached ? <small className="pane-worklog-process-detached" title="Started from this pane but no longer part of its process tree: closing the pane does not stop it">detached</small> : null}
                {process.ports.map((port) => <a key={port} href={openPortUrl(port)} target="_blank" rel="noreferrer">:{port}</a>)}
              </div> : null}
            </div>
            <button type="button" disabled={!connected || stopping.has(process.key)} onClick={() => { void stop(process) }}
              aria-label={`Stop ${process.command}`} title="Stop: SIGTERM, then SIGKILL if it is still running after 3 seconds">
              {stopping.has(process.key) ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        ))}
      </div>
      {stopError ? <p className="pane-worklog-processes-error" role="alert">{stopError}</p> : null}
    </section>
  )
}
