// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NativeTerminalBridge,
  NATIVE_TERMINAL_PROTOCOL,
  REQUIRED_NATIVE_TERMINAL_CAPABILITIES,
  resetNativeTerminalBridge,
  type NativeTerminalMessage,
} from './nativeTerminalBridge'

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

function receive(bridge: NativeTerminalBridge, eventSequence: number, type: string, payload: object) {
  window.__commandoNativeTerminalReceive?.({
    version: 1,
    pageId: bridge.pageId,
    eventSequence,
    type,
    payload,
  })
}

async function connect(bridge: NativeTerminalBridge) {
  const pending = bridge.connect()
  receive(bridge, 1, 'bridge.connected', {
    capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES],
    maxPanes: 4,
  })
  await expect(pending).resolves.toMatchObject({ available: true, maxPanes: 4 })
}

beforeEach(() => {
  resetNativeTerminalBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeTerminalReceive
})

afterEach(() => {
  vi.useRealTimers()
  resetNativeTerminalBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeTerminalReceive
})

describe('NativeTerminalBridge negotiation', () => {
  it('uses the exact versioned connect envelope and accepts required capabilities', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()

    const pending = bridge.connect()

    expect(messages).toEqual([{
      protocol: NATIVE_TERMINAL_PROTOCOL,
      version: 1,
      pageId: bridge.pageId,
      sequence: 1,
      type: 'bridge.connect',
      payload: { supportedVersions: [1] },
    }])
    receive(bridge, 1, 'bridge.connected', {
      capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES, 'terminal.extra.v1'],
      maxPanes: 3,
    })

    await expect(pending).resolves.toEqual({
      available: true,
      capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES, 'terminal.extra.v1'],
      maxPanes: 3,
    })
    bridge.dispose()
  })

  it('falls back for an absent handler, missing capabilities, version mismatch, and timeout', async () => {
    const absent = new NativeTerminalBridge()
    await expect(absent.connect()).resolves.toEqual({ available: false, reason: 'handler-absent' })
    absent.dispose()

    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const missing = new NativeTerminalBridge()
    const missingPending = missing.connect()
    receive(missing, 1, 'bridge.connected', { capabilities: [], maxPanes: 2 })
    await expect(missingPending).resolves.toEqual({ available: false, reason: 'missing-capabilities' })
    missing.dispose()

    const mismatched = new NativeTerminalBridge()
    const mismatchPending = mismatched.connect()
    window.__commandoNativeTerminalReceive?.({
      version: 2,
      pageId: mismatched.pageId,
      eventSequence: 1,
      type: 'bridge.connected',
      payload: { capabilities: [...REQUIRED_NATIVE_TERMINAL_CAPABILITIES], maxPanes: 2 },
    })
    await expect(mismatchPending).resolves.toEqual({ available: false, reason: 'version-mismatch' })
    mismatched.dispose()

    vi.useFakeTimers()
    const timedOut = new NativeTerminalBridge(25)
    const timeoutPending = timedOut.connect()
    await vi.advanceTimersByTimeAsync(26)
    await expect(timeoutPending).resolves.toEqual({ available: false, reason: 'handshake-timeout' })
    timedOut.dispose()
  })
})

describe('NativeTerminalBridge event isolation', () => {
  it('ignores malformed, stale-page, and non-monotonic shortcut events', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    await connect(bridge)
    const shortcut = vi.fn()
    const domShortcut = vi.fn()
    bridge.subscribeHostShortcuts(shortcut)
    window.addEventListener('commando:native-terminal-shortcut', domShortcut)

    window.__commandoNativeTerminalReceive?.({
      version: 1,
      pageId: 'stale-page',
      eventSequence: 2,
      type: 'host.shortcut',
      payload: { key: 'k', metaKey: true },
    })
    receive(bridge, 2, 'host.shortcut', { key: 'x', metaKey: true })
    receive(bridge, 2, 'host.shortcut', { key: 'k', metaKey: true })
    receive(bridge, 2, 'host.shortcut', { key: '1', metaKey: true })

    expect(shortcut).toHaveBeenCalledOnce()
    expect(shortcut).toHaveBeenCalledWith('k')
    expect(domShortcut).toHaveBeenCalledOnce()
    window.removeEventListener('commando:native-terminal-shortcut', domShortcut)
    bridge.dispose()
  })

  it('routes only the active pane attachment and bounds attach acknowledgement', async () => {
    vi.useFakeTimers()
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge(100, 40)
    await connect(bridge)
    const listener = vi.fn()
    const attachment = bridge.attach('%1', 'attachment-current', 'Pane 1 terminal', listener)

    receive(bridge, 2, 'pane.attached', { paneId: '%1', attachmentId: 'attachment-stale' })
    expect(listener).not.toHaveBeenCalled()
    receive(bridge, 3, 'pane.attached', { paneId: '%1', attachmentId: 'attachment-current' })
    await expect(attachment.ready).resolves.toBeUndefined()
    listener.mockClear()

    receive(bridge, 4, 'pane.input_bytes', {
      paneId: '%2',
      attachmentId: 'attachment-current',
      data: 'AP+A',
    })
    receive(bridge, 5, 'pane.input_bytes', {
      paneId: '%1',
      attachmentId: 'attachment-current',
      data: 'AP+A',
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]?.[0].payload.data).toBe('AP+A')

    attachment.detach()
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.detach',
      payload: { paneId: '%1', attachmentId: 'attachment-current' },
    })
    receive(bridge, 6, 'pane.input_bytes', {
      paneId: '%1',
      attachmentId: 'attachment-current',
      data: 'AQ==',
    })
    expect(listener).toHaveBeenCalledOnce()

    const timeoutAttachment = bridge.attach('%2', 'attachment-timeout', 'Pane 2 terminal', vi.fn())
    const timeoutResult = timeoutAttachment.ready.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(41)
    await expect(timeoutResult).resolves.toBe('Native terminal attach timed out')
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.detach',
      payload: { paneId: '%2', attachmentId: 'attachment-timeout' },
    })
    bridge.dispose()
  })
})
