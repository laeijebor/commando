// @vitest-environment jsdom

import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaneTerminalState } from '../shared/protocol'
import {
  computeNativeTerminalVisibleRegions,
  MAX_NATIVE_TERMINAL_VISIBLE_REGIONS,
  NativeTerminalPane,
} from './NativeTerminalPane'
import {
  NativeTerminalBridge,
  REQUIRED_NATIVE_TERMINAL_CAPABILITIES,
  resetNativeTerminalBridge,
  type NativeTerminalMessage,
} from './nativeTerminalBridge'
import type { PaneTerminalSink } from './paneStream'
import {
  PANE_RESET_MAX_REQUESTS,
  PANE_RESET_RETRY_MS,
  TerminalPaneRenderer,
} from './TerminalPaneRenderer'

vi.mock('./XtermPane', () => ({
  XtermPane: ({
    paneId,
    connected,
    ariaLabel,
    registerSink,
  }: {
    paneId: string
    connected: boolean
    ariaLabel: string
    registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  }) => {
    useEffect(() => registerSink(paneId, { reset: () => {}, write: () => {} }), [paneId, registerSink])
    return (
      <div
        data-testid={`xterm-${paneId}`}
        role="application"
        aria-label={ariaLabel}
        aria-disabled={!connected}
      />
    )
  },
}))

const terminalState: PaneTerminalState = {
  width: 80,
  height: 24,
  cursorX: 0,
  cursorY: 0,
  alternateSavedX: 0,
  alternateSavedY: 0,
  alternateOn: false,
  cursorVisible: true,
  cursorShape: 'default',
  cursorBlinking: false,
  scrollRegionUpper: 0,
  scrollRegionLower: 23,
  wrapFlag: true,
  originFlag: false,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: false,
  mouseAnyFlag: false,
  mouseSgrFlag: false,
  paneTabs: [],
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  }
}

let placeholderBounds = rect(10, 10, 90, 80)

function installHandler(messages: NativeTerminalMessage[]) {
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        commandoNativeTerminal: {
          postMessage: (message: NativeTerminalMessage) => messages.push(message),
        },
      },
    },
  })
}

function receiver(bridge: NativeTerminalBridge) {
  let eventSequence = 0
  return (type: string, payload: object) => {
    eventSequence += 1
    window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: bridge.pageId,
      eventSequence,
      type,
      payload,
    })
  }
}

async function connectBridge(bridge: NativeTerminalBridge, receive: ReturnType<typeof receiver>) {
  const pending = bridge.connect()
  receive('bridge.connected', {
    capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES],
    maxPanes: 8,
  })
  await pending
}

function nativeProps(bridge: NativeTerminalBridge) {
  let sink: PaneTerminalSink | undefined
  const props = {
    bridge,
    paneId: '%1',
    connected: true,
    resizeOwner: true,
    order: 2,
    ariaLabel: 'Pane 1 terminal input',
    onFocus: vi.fn(),
    onInputBytes: vi.fn(),
    onPaste: vi.fn(),
    onSelectionCopied: vi.fn(),
    onOpenMenu: vi.fn(),
    onResize: vi.fn(),
    onFailure: vi.fn(),
    registerSink: vi.fn((_paneId: string, nextSink: PaneTerminalSink) => {
      sink = nextSink
      return vi.fn()
    }),
    registerFocusable: vi.fn(),
  }
  return { props, getSink: () => sink }
}

function rendererFixture(connected = true, paneId = '%1') {
  let sink: PaneTerminalSink | undefined
  const props = {
    paneId,
    cols: 80,
    rows: 24,
    terminalState,
    connected,
    resizeOwner: true,
    measurementKey: 'layout',
    ariaLabel: `${paneId} terminal input${connected ? '' : ', disconnected'}`,
    order: 0,
    onFocus: vi.fn(),
    onInput: vi.fn(),
    onInputBytes: vi.fn(),
    onOpenMenu: vi.fn(),
    onKey: vi.fn(),
    onPaste: vi.fn(),
    onSelectionCopied: vi.fn(),
    onResize: vi.fn(),
    onRequestReset: vi.fn(),
    onRendererChange: vi.fn(),
    registerSink: vi.fn((_paneId: string, nextSink: PaneTerminalSink) => {
      sink = nextSink
      return () => {
        if (sink === nextSink) sink = undefined
      }
    }),
    registerFocusable: vi.fn(),
  }
  return { props, getSink: () => sink }
}

beforeEach(() => {
  resetNativeTerminalBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeTerminalReceive
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 100 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 90 })
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  placeholderBounds = rect(10, 10, 90, 80)
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn((callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    )),
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn((handle: number) => window.clearTimeout(handle)),
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds(this: HTMLElement) {
    if (this.dataset.occluderPosition === 'far') return rect(0, 0, 5, 5)
    if (this.dataset.occluderPosition === 'full') return placeholderBounds
    if (this.hasAttribute('data-native-terminal-occluder')) return rect(20, 20, 40, 40)
    if (this.dataset.clippingAncestor === 'fractional') return rect(0, 0, 100, 90)
    if (this.hasAttribute('data-clipping-ancestor')) return rect(0, 0, 60, 90)
    if (this.hasAttribute('data-native-terminal-pane')) return placeholderBounds
    return rect(0, 0, 0, 0)
  })
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  resetNativeTerminalBridge()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeTerminalReceive
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
  document.querySelectorAll('[data-native-terminal-occluder]').forEach((node) => node.remove())
})

describe('NativeTerminalPane', () => {
  it('forwards canonical sink bytes, binary input, native resize, focus, and clipped frames', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props, getSink } = nativeProps(bridge)
    render(<NativeTerminalPane {...props} />)

    const attach = messages.find((message) => message.type === 'pane.attach')!
    const attachmentId = attach.payload.attachmentId as string
    act(() => receive('pane.attached', { paneId: '%1', attachmentId }))

    act(() => getSink()!.reset({
      data: new Uint8Array([0, 255, 128, 1, 2]),
      cols: 91,
      rows: 31,
      terminalState,
      revision: 7,
    }))
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.reset',
      payload: { paneId: '%1', attachmentId, data: 'AP+AAQI=', cols: 91, rows: 31, revision: 7 },
    })
    act(() => receive('pane.seeded', { paneId: '%1', attachmentId, revision: 7 }))
    act(() => getSink()!.write(new Uint8Array([255, 0, 65]), 8))
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.data',
      payload: { paneId: '%1', attachmentId, data: '/wBB', revision: 8 },
    })

    act(() => receive('pane.input_bytes', { paneId: '%1', attachmentId, data: 'AP+A' }))
    expect(props.onInputBytes).toHaveBeenCalledWith('AP+A')
    act(() => receive('pane.paste_text', { paneId: '%1', attachmentId, data: 'paste text' }))
    expect(props.onPaste).toHaveBeenCalledWith('paste text')
    act(() => receive('pane.selection_copied', { paneId: '%1', attachmentId }))
    expect(props.onSelectionCopied).toHaveBeenCalledOnce()
    act(() => receive('pane.context_menu', { paneId: '%1', attachmentId, x: 120.5, y: 80.25 }))
    expect(props.onOpenMenu).toHaveBeenCalledWith(120.5, 80.25)
    act(() => receive('pane.resize', { paneId: '%1', attachmentId, cols: 77, rows: 22 }))
    expect(props.onResize).toHaveBeenCalledWith(77, 22)
    act(() => receive('pane.focus_changed', { paneId: '%1', attachmentId, focused: true }))
    expect(props.onFocus).toHaveBeenCalledOnce()

    const placeholder = document.querySelector<HTMLElement>('[data-native-terminal-pane="%1"]')!
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(placeholder).not.toHaveAttribute('role')
    fireEvent.focus(placeholder)
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.focus',
      payload: { paneId: '%1', attachmentId },
    })
    await waitFor(() => expect(messages.some((message) => (
      message.type === 'pane.frame' &&
      message.payload.x === 10 &&
      message.payload.y === 10 &&
      message.payload.width === 80 &&
      message.payload.height === 70 &&
      message.payload.scale === 2 &&
      message.payload.visible === true &&
      JSON.stringify(message.payload.visibleRegions) === JSON.stringify([{
        x: 10,
        y: 10,
        width: 80,
        height: 70,
      }]) &&
      message.payload.resizeOwner === true &&
      message.payload.order === 2
    ))).toBe(true))
    bridge.dispose()
  })

  it('republishes changed bounds when the host reports a zoom layout change', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    render(<NativeTerminalPane {...props} />)
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))
    await waitFor(() => expect(messages.filter((message) => message.type === 'pane.frame')).toHaveLength(1))

    placeholderBounds = rect(15, 12, 95, 82)
    fireEvent.resize(window)

    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({ x: 15, y: 12, width: 80, height: 70 })
    })
    bridge.dispose()
  })

  it('publishes through the timer fallback when WebKit suspends animation frames', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    vi.mocked(window.requestAnimationFrame).mockImplementation(() => 47)

    render(<NativeTerminalPane {...props} />)

    await waitFor(() => {
      expect(messages.filter((message) => message.type === 'pane.frame')).toHaveLength(1)
    })
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(47)
    bridge.dispose()
  })

  it('keeps the populated native attachment while connection accessibility state changes', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props, getSink } = nativeProps(bridge)
    const view = render(<NativeTerminalPane {...props} />)
    const attach = messages.find((message) => message.type === 'pane.attach')!
    const attachmentId = attach.payload.attachmentId as string
    act(() => receive('pane.attached', { paneId: '%1', attachmentId }))
    act(() => getSink()!.reset({
      data: new Uint8Array([65]),
      cols: 80,
      rows: 24,
      terminalState,
      revision: 1,
    }))
    act(() => receive('pane.seeded', { paneId: '%1', attachmentId, revision: 1 }))

    view.rerender(
      <NativeTerminalPane
        {...props}
        connected={false}
        ariaLabel="Pane 1 terminal input, disconnected"
      />,
    )

    const placeholder = document.querySelector<HTMLElement>('[data-native-terminal-pane="%1"]')!
    expect(placeholder).not.toHaveAttribute('aria-hidden')
    expect(placeholder).toHaveAttribute('role', 'application')
    expect(placeholder).toHaveAttribute('aria-disabled', 'true')
    expect(placeholder).toHaveAttribute('aria-keyshortcuts', 'Meta+C Meta+V PageUp PageDown')
    const attachMessages = messages.filter((message) => message.type === 'pane.attach')
    expect(attachMessages).toHaveLength(1)
    const updates = messages.filter((message) => message.type === 'pane.update')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      payload: {
        paneId: '%1',
        attachmentId,
        ariaLabel: 'Pane 1 terminal input, disconnected',
        accessibilityEnabled: false,
        keyShortcuts: ['Meta+C', 'Meta+V', 'PageUp', 'PageDown'],
      },
    })
    expect(props.registerSink).toHaveBeenCalledOnce()
    expect(messages.filter((message) => message.type === 'pane.detach')).toHaveLength(0)
    bridge.dispose()
  })

  it('subtracts intersecting occluders while keeping uncovered regions visible', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    render(<NativeTerminalPane {...props} />)
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))

    const note = document.createElement('div')
    note.className = 'notes-editor popped-out'
    note.dataset.occluderPosition = 'far'
    note.setAttribute('data-native-terminal-occluder', '')
    document.body.append(note)
    fireEvent.scroll(window)

    await waitFor(() => {
      const frames = messages.filter((message) => message.type === 'pane.frame')
      expect(frames.at(-1)?.payload.visible).toBe(true)
    })

    const contextMenu = document.createElement('div')
    contextMenu.className = 'pane-context-menu'
    contextMenu.setAttribute('data-native-terminal-occluder', '')
    document.body.append(contextMenu)
    fireEvent.scroll(window)
    await waitFor(() => {
      const frames = messages.filter((message) => message.type === 'pane.frame')
      expect(frames.at(-1)?.payload).toMatchObject({
        visible: true,
        visibleRegions: [
          { x: 10, y: 10, width: 80, height: 10 },
          { x: 10, y: 40, width: 80, height: 40 },
          { x: 10, y: 20, width: 10, height: 20 },
          { x: 40, y: 20, width: 50, height: 20 },
        ],
      })
    })
    bridge.dispose()
  })

  it('sends the clipped visible region when a scroll ancestor partially clips the pane', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    const view = render(
      <div data-clipping-ancestor="" style={{ overflow: 'auto' }}>
        <NativeTerminalPane {...props} />
      </div>,
    )
    const clippingAncestor = view.container.querySelector<HTMLElement>('[data-clipping-ancestor]')!
    Object.defineProperties(clippingAncestor, {
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
      clientWidth: { configurable: true, value: 60 },
      clientHeight: { configurable: true, value: 90 },
    })
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))
    fireEvent.scroll(clippingAncestor)

    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({
        x: 10,
        y: 10,
        width: 80,
        height: 70,
        visible: true,
        visibleRegions: [{ x: 10, y: 10, width: 50.5, height: 70 }],
      })
    })
    bridge.dispose()
  })

  it('hides a surface only when an occluder covers every visible region', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    render(<NativeTerminalPane {...props} />)
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))

    const cover = document.createElement('div')
    cover.dataset.occluderPosition = 'full'
    cover.setAttribute('data-native-terminal-occluder', '')
    document.body.append(cover)
    fireEvent.scroll(window)

    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({ visible: false, visibleRegions: [] })
    })
    bridge.dispose()
  })

  it('keeps a transparent transition occluder until its marker is removed, then republishes', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    render(<NativeTerminalPane {...props} />)
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))

    const cover = document.createElement('div')
    cover.dataset.occluderPosition = 'full'
    cover.style.opacity = '0'
    cover.setAttribute('data-native-terminal-occluder', '')
    document.body.append(cover)

    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({ visible: false, visibleRegions: [] })
    })

    cover.removeAttribute('data-native-terminal-occluder')
    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({ visible: true })
      expect(frame?.payload.visibleRegions).not.toEqual([])
    })
    bridge.dispose()
  })

  it('tolerates fractional layout rounding and reports genuine clipping as a partial region', async () => {
    placeholderBounds = rect(0, 0, 100.390625, 80)
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    const view = render(
      <div data-clipping-ancestor="fractional" style={{ overflow: 'hidden' }}>
        <NativeTerminalPane {...props} />
      </div>,
    )
    const clippingAncestor = view.container.querySelector<HTMLElement>('[data-clipping-ancestor]')!
    Object.defineProperties(clippingAncestor, {
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 90 },
    })
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attach.payload.attachmentId,
    }))
    fireEvent.scroll(clippingAncestor)

    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({ width: 100.390625, visible: true })
    })

    placeholderBounds = rect(0, 0, 102, 80)
    fireEvent.scroll(clippingAncestor)
    await waitFor(() => {
      const frame = messages.filter((message) => message.type === 'pane.frame').at(-1)
      expect(frame?.payload).toMatchObject({
        width: 102,
        visible: true,
        visibleRegions: [{ x: 0, y: 0, width: 100.5, height: 80 }],
      })
    })
    bridge.dispose()
  })

  it('bounds region fragmentation conservatively', () => {
    const occluders = Array.from({ length: MAX_NATIVE_TERMINAL_VISIBLE_REGIONS }, (_, index) => ({
      left: index * 2 + 1,
      top: 0,
      right: index * 2 + 2,
      bottom: 100,
    }))

    const regions = computeNativeTerminalVisibleRegions(
      { left: 0, top: 0, right: 200, bottom: 100 },
      { left: 0, top: 0, right: 200, bottom: 100 },
      occluders,
    )

    expect(regions.length).toBeLessThanOrEqual(MAX_NATIVE_TERMINAL_VISIBLE_REGIONS)
    expect(regions.every((region) => region.width > 0 && region.height > 0)).toBe(true)
  })

  it('uses a new attachment for the StrictMode replay so stale cleanup cannot detach its replacement', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    const receive = receiver(bridge)
    await connectBridge(bridge, receive)
    const { props } = nativeProps(bridge)
    const view = render(<StrictMode><NativeTerminalPane {...props} /></StrictMode>)

    const attaches = messages.filter((message) => message.type === 'pane.attach')
    const detaches = messages.filter((message) => message.type === 'pane.detach')
    expect(attaches).toHaveLength(2)
    expect(detaches).toHaveLength(1)
    expect(attaches[0]?.payload.attachmentId).not.toBe(attaches[1]?.payload.attachmentId)
    expect(detaches[0]?.payload.attachmentId).toBe(attaches[0]?.payload.attachmentId)

    act(() => receive('pane.detached', {
      paneId: '%1',
      attachmentId: attaches[0]?.payload.attachmentId,
    }))
    act(() => receive('pane.attached', {
      paneId: '%1',
      attachmentId: attaches[1]?.payload.attachmentId,
    }))
    await act(async () => {})
    expect(props.onFailure).not.toHaveBeenCalled()
    view.unmount()
    expect(messages.filter((message) => message.type === 'pane.detach').at(-1)?.payload.attachmentId)
      .toBe(attaches[1]?.payload.attachmentId)
    bridge.dispose()
  })
})

describe('TerminalPaneRenderer fallback', () => {
  it('stays xterm-only without a WebKit handler and emits no console error', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { props } = rendererFixture()
    render(<TerminalPaneRenderer {...props} />)

    expect(screen.getByTestId('xterm-%1')).toBeInTheDocument()
    expect(screen.getByRole('application', { name: '%1 terminal input' })).toHaveAttribute('aria-disabled', 'false')
    expect(props.onRequestReset).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('reports automatic fallback and explicitly retries with a fresh attachment and seed', async () => {
    vi.useFakeTimers()
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const { props, getSink } = rendererFixture()
    const view = render(<TerminalPaneRenderer {...props} />)
    expect(props.onRequestReset).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    expect(messages.some((message) => message.type === 'bridge.connect')).toBe(true)
    const connectMessage = messages.find((message) => message.type === 'bridge.connect')!
    await act(async () => {
      window.__commandoNativeTerminalReceive?.({
        version: 1,
        pageId: connectMessage.pageId,
        eventSequence: 1,
        type: 'bridge.connected',
        payload: { capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES], maxPanes: 4 },
      })
    })
    expect(screen.getByRole('application', { name: '%1 terminal input' })).not.toHaveAttribute('aria-hidden')
    act(() => vi.advanceTimersByTime(0))
    const attach = messages.find((message) => message.type === 'pane.attach')!
    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: attach.pageId,
      eventSequence: 2,
      type: 'pane.attached',
      payload: { paneId: '%1', attachmentId: attach.payload.attachmentId },
    }))
    expect(props.onRequestReset).toHaveBeenCalledTimes(2)
    props.onRendererChange.mockClear()

    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: attach.pageId,
      eventSequence: 3,
      type: 'pane.failed',
      payload: {
        paneId: '%1',
        attachmentId: attach.payload.attachmentId,
        code: 'native-runtime-failed',
        fatal: false,
      },
    }))

    expect(screen.getByTestId('xterm-%1')).toBeInTheDocument()
    expect(screen.getByRole('application', { name: '%1 terminal input' })).toBeInTheDocument()
    expect(props.onRendererChange).toHaveBeenLastCalledWith('xterm')
    expect(messages.filter((message) => message.type === 'pane.attach')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledTimes(3)

    view.rerender(<TerminalPaneRenderer {...props} nativeRetryKey={1} />)
    await act(async () => {})

    const attaches = messages.filter((message) => message.type === 'pane.attach')
    expect(attaches).toHaveLength(2)
    const replacementAttach = attaches[1]!
    expect(replacementAttach.payload.attachmentId).not.toBe(attach.payload.attachmentId)
    expect(messages.filter((message) => (
      message.type === 'pane.detach' && message.payload.attachmentId === attach.payload.attachmentId
    ))).toHaveLength(1)

    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: attach.pageId,
      eventSequence: 4,
      type: 'pane.seeded',
      payload: { paneId: '%1', attachmentId: attach.payload.attachmentId, revision: 9 },
    }))
    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: replacementAttach.pageId,
      eventSequence: 5,
      type: 'pane.attached',
      payload: { paneId: '%1', attachmentId: replacementAttach.payload.attachmentId },
    }))
    act(() => vi.advanceTimersByTime(0))
    act(() => getSink()!.reset({
      data: new Uint8Array([65]),
      cols: 80,
      rows: 24,
      terminalState,
      revision: 9,
    }))
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.reset',
      payload: { attachmentId: replacementAttach.payload.attachmentId, revision: 9 },
    })

    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: attach.pageId,
      eventSequence: 6,
      type: 'pane.seeded',
      payload: { paneId: '%1', attachmentId: attach.payload.attachmentId, revision: 9 },
    }))
    act(() => vi.advanceTimersByTime(1_000))
    expect(document.querySelector('[data-native-terminal-pane="%1"]')).toBeInTheDocument()
    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: replacementAttach.pageId,
      eventSequence: 7,
      type: 'pane.seeded',
      payload: { paneId: '%1', attachmentId: replacementAttach.payload.attachmentId, revision: 9 },
    }))
    act(() => vi.advanceTimersByTime(1_000))
    expect(props.onRendererChange).toHaveBeenLastCalledWith('native')

    view.unmount()
    expect(messages.filter((message) => (
      message.type === 'pane.detach' &&
      message.payload.attachmentId === replacementAttach.payload.attachmentId
    ))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detaches and reseeds only the pane whose renderer override changes', async () => {
    vi.useFakeTimers()
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const first = rendererFixture(true, '%1')
    const second = rendererFixture(true, '%2')
    const view = render(
      <>
        <TerminalPaneRenderer {...first.props} />
        <TerminalPaneRenderer {...second.props} />
      </>,
    )
    const connectMessage = messages.find((message) => message.type === 'bridge.connect')!
    await act(async () => {
      window.__commandoNativeTerminalReceive?.({
        version: 1,
        pageId: connectMessage.pageId,
        eventSequence: 1,
        type: 'bridge.connected',
        payload: { capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES], maxPanes: 4 },
      })
    })

    const initialAttaches = messages.filter((message) => message.type === 'pane.attach')
    expect(initialAttaches.map((message) => message.payload.paneId)).toEqual(['%1', '%2'])
    initialAttaches.forEach((attach, index) => {
      act(() => window.__commandoNativeTerminalReceive?.({
        version: 1,
        pageId: attach.pageId,
        eventSequence: index + 2,
        type: 'pane.attached',
        payload: { paneId: attach.payload.paneId, attachmentId: attach.payload.attachmentId },
      }))
    })
    act(() => vi.advanceTimersByTime(0))
    first.props.onRequestReset.mockClear()
    second.props.onRequestReset.mockClear()
    messages.splice(0)

    view.rerender(
      <>
        <TerminalPaneRenderer {...first.props} useXtermFallback />
        <TerminalPaneRenderer {...second.props} />
      </>,
    )

    expect(messages.filter((message) => message.type === 'pane.detach').map((message) => message.payload.paneId))
      .toEqual(['%1'])
    expect(messages.some((message) => message.type === 'pane.attach')).toBe(false)
    act(() => vi.advanceTimersByTime(0))
    expect(first.props.onRequestReset).toHaveBeenCalledOnce()
    expect(second.props.onRequestReset).not.toHaveBeenCalled()
    first.props.onRequestReset.mockClear()
    messages.splice(0)

    view.rerender(
      <>
        <TerminalPaneRenderer {...first.props} />
        <TerminalPaneRenderer {...second.props} />
      </>,
    )

    const replacementAttach = messages.find((message) => message.type === 'pane.attach')!
    expect(replacementAttach.payload.paneId).toBe('%1')
    expect(messages.some((message) => (
      message.type === 'pane.attach' && message.payload.paneId === '%2'
    ))).toBe(false)
    act(() => window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: replacementAttach.pageId,
      eventSequence: 4,
      type: 'pane.attached',
      payload: { paneId: '%1', attachmentId: replacementAttach.payload.attachmentId },
    }))
    act(() => vi.advanceTimersByTime(0))
    expect(first.props.onRequestReset).toHaveBeenCalledOnce()
    expect(second.props.onRequestReset).not.toHaveBeenCalled()
  })
})

describe('terminal reset watchdog', () => {
  it('bounds retries when no reset arrives', () => {
    vi.useFakeTimers()
    const { props } = rendererFixture()
    const view = render(<TerminalPaneRenderer {...props} />)

    expect(props.onRequestReset).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * (PANE_RESET_MAX_REQUESTS + 2)))
    expect(props.onRequestReset).toHaveBeenCalledTimes(PANE_RESET_MAX_REQUESTS)
    view.unmount()
  })

  it('stops retrying when the sink receives its first reset', () => {
    vi.useFakeTimers()
    const { props, getSink } = rendererFixture()
    render(<TerminalPaneRenderer {...props} />)

    act(() => getSink()!.reset({
      data: new Uint8Array([65]),
      cols: 80,
      rows: 24,
      terminalState,
      revision: 1,
    }))
    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * PANE_RESET_MAX_REQUESTS))
    expect(props.onRequestReset).not.toHaveBeenCalled()
  })

  it('waits past the server gate before retrying a rate-limited-like request', () => {
    vi.useFakeTimers()
    const { props, getSink } = rendererFixture()
    render(<TerminalPaneRenderer {...props} />)

    expect(props.onRequestReset).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(2_000))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS - 2_000))
    expect(props.onRequestReset).toHaveBeenCalledTimes(2)
    act(() => getSink()!.reset({
      data: new Uint8Array([65]),
      cols: 80,
      rows: 24,
      terminalState,
      revision: 1,
    }))
    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * 2))
    expect(props.onRequestReset).toHaveBeenCalledTimes(2)
  })

  it('stays quiet offline and restarts the watchdog on reconnect', () => {
    vi.useFakeTimers()
    const { props } = rendererFixture(false)
    const view = render(<TerminalPaneRenderer {...props} />)

    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * 2))
    expect(props.onRequestReset).not.toHaveBeenCalled()
    view.rerender(<TerminalPaneRenderer {...props} connected ariaLabel="Pane 1 terminal input" />)
    expect(props.onRequestReset).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    view.rerender(
      <TerminalPaneRenderer
        {...props}
        connected={false}
        ariaLabel="Pane 1 terminal input, disconnected"
      />,
    )
    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * 2))
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    view.rerender(<TerminalPaneRenderer {...props} connected ariaLabel="Pane 1 terminal input" />)
    expect(props.onRequestReset).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(0))
    expect(props.onRequestReset).toHaveBeenCalledTimes(2)
  })

  it('clears pending retries when the renderer unmounts', () => {
    vi.useFakeTimers()
    const { props } = rendererFixture()
    const view = render(<TerminalPaneRenderer {...props} />)
    view.unmount()

    act(() => vi.advanceTimersByTime(PANE_RESET_RETRY_MS * PANE_RESET_MAX_REQUESTS))
    expect(props.onRequestReset).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
