import { invoke } from '@tauri-apps/api/core'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type NativeTerminalMessage =
  | {
      kind: 'frame'
      x: number
      y: number
      width: number
      height: number
      visible: boolean
      scale: number
    }
  | { kind: 'focus' }

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
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

async function sendNativeMessage(message: NativeTerminalMessage): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    await invoke('native_terminal_message', { message })
    return
  }
  window.webkit?.messageHandlers?.nativeTerminal?.postMessage(message)
}

function App() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const [terminalHeight, setTerminalHeight] = useState(330)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const shell = shellName()

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
              <div>
                <span className="status-dot" />
                <strong>native-surface</strong>
                <code>%1</code>
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
              <li>Native surface exactly covers the crosshatch.</li>
              <li>Resize and sidebar changes track without drift.</li>
              <li>Focus button accepts native text input.</li>
              <li>Web overlay hides the native surface.</li>
              <li>Editing this React file hot reloads in place.</li>
            </ol>
            <div className="metric"><span>Renderer</span><strong>AppKit NSView</strong></div>
            <div className="metric"><span>Web shell</span><strong>React + Vite</strong></div>
            <div className="metric"><span>Bridge</span><strong>{shell}</strong></div>
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
