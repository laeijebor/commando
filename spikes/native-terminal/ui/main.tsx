import { invoke } from '@tauri-apps/api/core'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { CommandoSnapshot, ServerMessage } from '../../../shared/protocol'
import { decodeBase64Bytes, PaneStreamRegistry } from '../../../src/paneStream'
import { useDaemon } from '../../../src/useDaemon'
import {
  boundedTerminalSize,
  chunkTerminalInput,
  createNativeTerminalSink,
  decodeNativeInput,
  parseNativeTerminalEvent,
  resolveSpikeToken,
  selectLivePane,
  type NativeTerminalEvent,
  type NativeTerminalMessage,
} from './nativeTerminal'
import './styles.css'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    __commandoNativeTerminalEvent?: (event: NativeTerminalEvent) => void
    webkit?: {
      messageHandlers?: {
        nativeTerminal?: { postMessage(message: NativeTerminalMessage): void }
      }
    }
  }
}

function shellName(): string {
  return new URLSearchParams(window.location.search).get('shell') ?? 'browser'
}

function requestedPaneId(): string | null {
  return new URLSearchParams(window.location.search).get('pane')
}

const SPIKE_TOKEN_STORAGE_KEY = 'commando.native-terminal-spike-token'

function initialSpikeToken(): string {
  let storedToken = ''
  try {
    storedToken = window.sessionStorage.getItem(SPIKE_TOKEN_STORAGE_KEY) ?? ''
  } catch {
    // The URL token still works if WebKit storage is unavailable.
  }

  const resolved = resolveSpikeToken(window.location, storedToken)
  if (resolved.token) {
    try {
      window.sessionStorage.setItem(SPIKE_TOKEN_STORAGE_KEY, resolved.token)
    } catch {
      // Keep the token in memory when storage is unavailable.
    }
  }
  if (resolved.shouldScrub) {
    window.history.replaceState(null, '', resolved.scrubbedUrl)
  }
  return resolved.token
}

const spikeToken = initialSpikeToken()

let requestSequence = 0

function requestId(prefix: string): string {
  requestSequence += 1
  return `${prefix}-${Date.now()}-${requestSequence}`
}

async function sendNativeMessage(message: NativeTerminalMessage): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    await invoke('native_terminal_message', { message })
    return
  }
  window.webkit?.messageHandlers?.nativeTerminal?.postMessage(message)
}

function App() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const paneStreamsRef = useRef<PaneStreamRegistry | null>(null)
  if (!paneStreamsRef.current) paneStreamsRef.current = new PaneStreamRegistry()

  const [terminalHeight, setTerminalHeight] = useState(330)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<CommandoSnapshot | null>(null)
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(requestedPaneId)
  const shell = shellName()
  const liveNativeTerminal = shell === 'swift' && spikeToken.length > 0

  const handleServerMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'snapshot':
        setSnapshot(message.snapshot)
        setSelectedPaneId((current) => (
          selectLivePane(message.snapshot.panes, current)?.id ?? null
        ))
        break
      case 'pane_reset':
        try {
          paneStreamsRef.current?.pushReset(message.paneId, {
            data: decodeBase64Bytes(message.data),
            cols: message.cols,
            rows: message.rows,
            terminalState: message.terminalState,
            revision: message.revision,
          })
        } catch {
          console.error(`[native-terminal:pane-reset] Ignored invalid base64 for ${message.paneId}`)
        }
        break
      case 'pane_data':
        try {
          paneStreamsRef.current?.pushData(
            message.paneId,
            decodeBase64Bytes(message.data),
            message.revision,
          )
        } catch {
          console.error(`[native-terminal:pane-data] Ignored invalid base64 for ${message.paneId}`)
        }
        break
    }
  }

  const { connection, send } = useDaemon(
    liveNativeTerminal ? spikeToken : '',
    false,
    handleServerMessage,
  )
  const connected = connection.phase === 'live'
  const selectedPane = snapshot?.panes.find((pane) => pane.id === selectedPaneId) ?? null

  useEffect(() => {
    if (!liveNativeTerminal || !connected) return
    send({
      type: 'subscribe',
      paneIds: selectedPaneId ? [selectedPaneId] : [],
      statusPaneIds: [],
    })
  }, [connected, liveNativeTerminal, selectedPaneId, send])

  useEffect(() => {
    if (connection.phase !== 'live') paneStreamsRef.current?.clear()
  }, [connection.phase])

  useEffect(() => {
    if (!liveNativeTerminal || !selectedPaneId) return
    return paneStreamsRef.current?.register(
      selectedPaneId,
      createNativeTerminalSink(selectedPaneId, (message) => {
        void sendNativeMessage(message)
      }),
    )
  }, [liveNativeTerminal, selectedPaneId])

  useEffect(() => {
    if (!liveNativeTerminal || !connected || !selectedPaneId) return

    let resizeTimer: number | undefined
    const receiveNativeEvent: NonNullable<Window['__commandoNativeTerminalEvent']> = (value) => {
      const event = parseNativeTerminalEvent(value)
      if (!event) return

      if (event.kind === 'input') {
        const input = decodeNativeInput(event.data)
        if (input === null) return
        for (const data of chunkTerminalInput(input)) {
          send({
            type: 'input',
            paneId: selectedPaneId,
            data,
            requestId: requestId('native-input'),
          })
        }
        return
      }

      const { cols, rows } = boundedTerminalSize(event)
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined
        send({
          type: 'resize_pane',
          paneId: selectedPaneId,
          cols,
          rows,
          requestId: requestId('native-resize'),
        })
      }, 80)
    }

    window.__commandoNativeTerminalEvent = receiveNativeEvent
    return () => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      if (window.__commandoNativeTerminalEvent === receiveNativeEvent) {
        delete window.__commandoNativeTerminalEvent
      }
      send({
        type: 'release_resize',
        paneId: selectedPaneId,
        requestId: requestId('native-resize-release'),
      })
    }
  }, [connected, liveNativeTerminal, selectedPaneId, send])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    let animationFrame = 0
    const publishFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        const rect = terminal.getBoundingClientRect()
        const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
        const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
        void sendNativeMessage({
          kind: 'frame',
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: visibleWidth,
          height: visibleHeight,
          visible: !overlayOpen && visibleWidth > 0 && visibleHeight > 0,
          scale: window.devicePixelRatio,
        })
      })
    }

    const observer = new ResizeObserver(publishFrame)
    observer.observe(terminal)
    window.addEventListener('resize', publishFrame)
    window.addEventListener('scroll', publishFrame, true)
    publishFrame()

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', publishFrame)
      window.removeEventListener('scroll', publishFrame, true)
      void sendNativeMessage({
        kind: 'frame',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
        scale: window.devicePixelRatio,
      })
    }
  }, [overlayOpen, sidebarOpen, terminalHeight])

  const connectionLabel = liveNativeTerminal
    ? connection.phase
    : shell === 'swift'
      ? 'token-required'
      : 'static'
  const connectionDetail = liveNativeTerminal
    ? connection.detail
    : shell === 'swift'
      ? 'Append the inherited development token to enable streaming'
      : 'Static comparison composition; daemon transport is disabled'
  const paneTitle = selectedPane?.title || (liveNativeTerminal ? 'Waiting for daemon snapshot' : 'native-surface')
  const paneCommand = selectedPane?.command || (liveNativeTerminal ? 'No live pane selected' : 'Static composition fixture')

  return (
    <main className={sidebarOpen ? 'shell' : 'shell sidebar-collapsed'}>
      <aside>
        <div className="brand-mark">C</div>
        <strong>Commando</strong>
        <nav aria-label="Spike sections">
          <button className="nav-active" type="button">Workspace</button>
          <button type="button">HUD</button>
          <button type="button">Notes</button>
        </nav>
        <small>Shared Vite renderer</small>
      </aside>

      <section className="workspace">
        <header>
          <div>
            <p className="eyebrow">Native terminal composition spike</p>
            <h1>{shell === 'browser' ? 'Waiting for a native shell' : `${shell} shell`}</h1>
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => setSidebarOpen((open) => !open)}>
              {sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
            </button>
            <button type="button" onClick={() => setOverlayOpen(true)}>Open web overlay</button>
          </div>
        </header>

        <div className="test-grid">
          <article className="terminal-card">
            <div className="card-header">
              <div className="pane-identity">
                <div>
                  <span className={`status-dot status-${connectionLabel}`} />
                  <strong>{paneTitle}</strong>
                  <code>{selectedPane?.id ?? '%1'}</code>
                </div>
                <small>{paneCommand}</small>
              </div>
              <button type="button" onClick={() => void sendNativeMessage({ kind: 'focus' })}>
                Focus native view
              </button>
            </div>
            <div
              ref={terminalRef}
              className="terminal-placeholder"
              style={{ height: terminalHeight }}
              data-native-terminal-placeholder
            >
              <span>If this crosshatch is visible, the native view is missing or misaligned.</span>
            </div>
            <div className="resize-row">
              <label htmlFor="terminal-height">Terminal height</label>
              <input
                id="terminal-height"
                type="range"
                min="180"
                max="520"
                value={terminalHeight}
                onChange={(event) => setTerminalHeight(Number(event.target.value))}
              />
              <output>{terminalHeight}px</output>
            </div>
          </article>

          <aside className="checks">
            <h2>Acceptance checks</h2>
            <ol>
              <li>SwiftTerm renders VT state, cursor, color, and alternate-screen sequences.</li>
              <li>The Swift shell receives a real reset plus ordered daemon stream for one pane.</li>
              <li>Native UTF-8, Escape, and control-key input reaches the selected tmux pane.</li>
              <li>Native cell measurements debounce into bounded tmux resize messages.</li>
              <li>Native surface exactly covers the crosshatch.</li>
              <li>Resize and sidebar changes track without drift.</li>
              <li>Focus button returns keyboard focus to the native terminal.</li>
              <li>Web overlay hides the native surface.</li>
              <li>Editing this React file hot reloads in place.</li>
            </ol>
            <div className="metric"><span>Renderer</span><strong>{shell === 'swift' ? 'SwiftTerm VT' : 'Static native surface'}</strong></div>
            <div className="metric"><span>Web shell</span><strong>React + Vite</strong></div>
            <div className="metric"><span>Bridge</span><strong>{shell}</strong></div>
            <div className="metric"><span>Connection</span><strong>{connectionLabel}</strong></div>
            <div className="metric metric-detail"><span>Status</span><strong>{connectionDetail}</strong></div>
          </aside>
        </div>
      </section>

      {overlayOpen ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
          <div className="overlay-card">
            <p className="eyebrow">CSS stacking test</p>
            <h2 id="overlay-title">The native terminal should be hidden now.</h2>
            <p>A native sibling cannot participate in the WebView's stacking contexts, so React explicitly reports this occlusion state to the shell.</p>
            <button type="button" autoFocus onClick={() => setOverlayOpen(false)}>Close overlay</button>
          </div>
        </div>
      ) : null}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
