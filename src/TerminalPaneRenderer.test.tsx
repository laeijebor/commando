// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { ACTIVE_HOST_STORAGE_KEY, HostProvider } from './HostContext'
import { TerminalPaneRenderer } from './TerminalPaneRenderer'
import type { PaneTerminalState } from '../shared/protocol'

const bridge = vi.hoisted(() => ({ connect: vi.fn(async () => ({ available: true })) }))
vi.mock('./nativeTerminalBridge', () => ({ getNativeTerminalBridge: () => bridge }))
vi.mock('./NativeTerminalPane', () => ({ NativeTerminalPane: () => <div>Native terminal</div> }))
vi.mock('./XtermPane', () => ({ XtermPane: () => <div>Web terminal</div> }))
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
const terminalState: PaneTerminalState = {
  width: 80, height: 24, cursorX: 0, cursorY: 0, alternateSavedX: 0, alternateSavedY: 0,
  alternateOn: false, cursorVisible: true, cursorShape: 'default', cursorBlinking: false,
  scrollRegionUpper: 0, scrollRegionLower: 23, wrapFlag: true, originFlag: false,
  insertFlag: false, keypadFlag: false, keypadCursorFlag: false, mouseAnyFlag: false,
  mouseSgrFlag: false, paneTabs: [],
}
function Pane() {
  return <TerminalPaneRenderer paneId="%1" order={0} cols={80} rows={24} terminalState={terminalState}
    connected resizeOwner measurementKey="test" ariaLabel="Pane" onFocus={vi.fn()} onInput={vi.fn()}
    onKey={vi.fn()} onPaste={vi.fn()} onSelectionCopied={vi.fn()} onResize={vi.fn()}
    onInputBytes={vi.fn()} onOpenMenu={vi.fn()} onRequestReset={vi.fn()}
    registerSink={() => () => {}} registerFocusable={vi.fn()} />
}
it('keeps the native renderer available on This Mac', async () => {
  render(<HostProvider><Pane /></HostProvider>)
  expect(await screen.findByText('Native terminal')).toBeInTheDocument()
  expect(bridge.connect).toHaveBeenCalledOnce()
})
it('renders remote panes with xterm without connecting the native bridge', () => {
  localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, 'hub')
  render(<HostProvider><Pane /></HostProvider>)
  expect(screen.getByText('Web terminal')).toBeInTheDocument()
  expect(screen.queryByText('Native terminal')).toBeNull()
  expect(bridge.connect).not.toHaveBeenCalled()
})
