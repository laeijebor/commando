// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  encodeBase64Bytes,
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
  it('posts exact attach and metadata update envelopes without a second attach', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    await connect(bridge)
    const metadata = {
      ariaLabel: 'Pane 1 terminal',
      accessibilityEnabled: true,
      keyShortcuts: ['Meta+C', 'Meta+V', 'PageUp', 'PageDown'],
    }

    const attachment = bridge.attach('%1', 'attachment-1', metadata, vi.fn())
    expect(messages[1]).toEqual({
      protocol: NATIVE_TERMINAL_PROTOCOL,
      version: 1,
      pageId: bridge.pageId,
      sequence: 2,
      type: 'pane.attach',
      payload: { paneId: '%1', attachmentId: 'attachment-1', ...metadata },
    })

    const updated = { ...metadata, ariaLabel: 'Pane 1 terminal, disconnected', accessibilityEnabled: false }
    expect(bridge.updateMetadata('attachment-1', updated)).toBe(true)
    expect(messages[2]).toEqual({
      protocol: NATIVE_TERMINAL_PROTOCOL,
      version: 1,
      pageId: bridge.pageId,
      sequence: 3,
      type: 'pane.update',
      payload: { paneId: '%1', attachmentId: 'attachment-1', ...updated },
    })
    expect(messages.filter((message) => message.type === 'pane.attach')).toHaveLength(1)

    receive(bridge, 2, 'pane.attached', { paneId: '%1', attachmentId: 'attachment-1' })
    await expect(attachment.ready).resolves.toBeUndefined()
    bridge.dispose()
  })

  it('rejects enormous finite frame geometry before posting it', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    await connect(bridge)
    const attachment = bridge.attach('%1', 'attachment-frame', {
      ariaLabel: 'Pane 1 terminal',
      accessibilityEnabled: true,
      keyShortcuts: ['Meta+C'],
    }, vi.fn())
    receive(bridge, 2, 'pane.attached', { paneId: '%1', attachmentId: 'attachment-frame' })
    await attachment.ready
    messages.splice(0)

    expect(bridge.frame('attachment-frame', {
      x: 0,
      y: 0,
      width: Number.MAX_VALUE,
      height: 100,
      scale: 1,
      visible: true,
      visibleRegions: [{ x: 1, y: 1, width: 1, height: 1 }],
      resizeOwner: true,
      order: 0,
    })).toBe(false)
    expect(messages).toEqual([])

    expect(bridge.frame('attachment-frame', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      scale: 2,
      visible: true,
      visibleRegions: [{ x: 1, y: 1, width: Number.MAX_VALUE, height: 1 }],
      resizeOwner: true,
      order: 0,
    })).toBe(false)
    expect(messages).toEqual([])

    expect(bridge.frame('attachment-frame', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      scale: 2,
      visible: true,
      visibleRegions: [{ x: 1, y: 1, width: 1, height: 1 }],
      resizeOwner: true,
      order: 0,
    })).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('pane.frame')
    bridge.dispose()
  })

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
    const metadata = {
      ariaLabel: 'Pane 1 terminal',
      accessibilityEnabled: true,
      keyShortcuts: ['Meta+C', 'Meta+V', 'PageUp', 'PageDown'],
    }
    const attachment = bridge.attach('%1', 'attachment-current', metadata, listener)

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

    const timeoutAttachment = bridge.attach('%2', 'attachment-timeout', {
      ...metadata,
      ariaLabel: 'Pane 2 terminal',
    }, vi.fn())
    const timeoutResult = timeoutAttachment.ready.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(41)
    await expect(timeoutResult).resolves.toBe('Native terminal attach timed out')
    expect(messages.at(-1)).toMatchObject({
      type: 'pane.detach',
      payload: { paneId: '%2', attachmentId: 'attachment-timeout' },
    })
    bridge.dispose()
  })

  it('routes a post-connect command rejection to its attachment immediately', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    await connect(bridge)
    const listener = vi.fn()
    const attachment = bridge.attach('%1', 'attachment-rejected', {
      ariaLabel: 'Pane 1 terminal',
      accessibilityEnabled: true,
      keyShortcuts: ['Meta+C'],
    }, listener)
    const readyResult = attachment.ready.catch((error: Error) => error.message)

    receive(bridge, 2, 'bridge.rejected', {
      reason: 'invalid_payload',
      paneId: '%1',
      attachmentId: 'attachment-rejected',
    })

    await expect(readyResult).resolves.toBe('Native terminal command rejected: invalid_payload')
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pane.failed',
      payload: {
        paneId: '%1',
        attachmentId: 'attachment-rejected',
        code: 'invalid_payload',
        fatal: false,
      },
    }))
    bridge.dispose()
  })

  it('strictly validates native paste, copied-selection, and context-menu events', async () => {
    const messages: NativeTerminalMessage[] = []
    installHandler(messages)
    const bridge = new NativeTerminalBridge()
    await connect(bridge)
    const listener = vi.fn()
    const attachment = bridge.attach('%1', 'attachment-actions', {
      ariaLabel: 'Pane 1 terminal',
      accessibilityEnabled: true,
      keyShortcuts: ['Meta+C', 'Meta+V', 'PageUp', 'PageDown'],
    }, listener)
    receive(bridge, 2, 'pane.attached', { paneId: '%1', attachmentId: 'attachment-actions' })
    await attachment.ready
    listener.mockClear()

    receive(bridge, 3, 'pane.paste_text', {
      paneId: '%1', attachmentId: 'attachment-actions', data: '',
    })
    receive(bridge, 3, 'pane.paste_text', {
      paneId: '%1', attachmentId: 'attachment-actions', data: 'bad\0paste',
    })
    receive(bridge, 3, 'pane.paste_text', {
      paneId: '%1', attachmentId: 'attachment-actions', data: 'x'.repeat(256 * 1024 + 1),
    })
    receive(bridge, 3, 'pane.paste_text', {
      paneId: '%1', attachmentId: 'attachment-actions', data: 'paste text', extra: true,
    })
    receive(bridge, 3, 'pane.paste_text', {
      paneId: '%1', attachmentId: 'attachment-actions', data: 'paste text',
    })
    receive(bridge, 4, 'pane.selection_copied', {
      paneId: '%1', attachmentId: 'attachment-actions', copied: true,
    })
    receive(bridge, 4, 'pane.selection_copied', {
      paneId: '%1', attachmentId: 'attachment-actions',
    })
    receive(bridge, 5, 'pane.context_menu', {
      paneId: '%1', attachmentId: 'attachment-actions', x: -1, y: 80,
    })
    receive(bridge, 5, 'pane.context_menu', {
      paneId: '%1', attachmentId: 'attachment-actions', x: 120.5, y: 80.25,
    })
    receive(bridge, 6, 'pane.input_bytes', {
      paneId: '%1',
      attachmentId: 'attachment-actions',
      data: encodeBase64Bytes(new Uint8Array(8 * 1_024 + 1)),
    })
    receive(bridge, 6, 'pane.resize', {
      paneId: '%1', attachmentId: 'attachment-actions', cols: 1, rows: 24,
    })
    receive(bridge, 6, 'pane.resize', {
      paneId: '%1', attachmentId: 'attachment-actions', cols: 80, rows: 201,
    })
    receive(bridge, 6, 'pane.resize', {
      paneId: '%1', attachmentId: 'attachment-actions', cols: 500, rows: 200,
    })

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: 'pane.paste_text',
        payload: { paneId: '%1', attachmentId: 'attachment-actions', data: 'paste text' },
      }),
      expect.objectContaining({
        type: 'pane.selection_copied',
        payload: { paneId: '%1', attachmentId: 'attachment-actions' },
      }),
      expect.objectContaining({
        type: 'pane.context_menu',
        payload: { paneId: '%1', attachmentId: 'attachment-actions', x: 120.5, y: 80.25 },
      }),
      expect.objectContaining({
        type: 'pane.resize',
        payload: { paneId: '%1', attachmentId: 'attachment-actions', cols: 500, rows: 200 },
      }),
    ])
    bridge.dispose()
  })
})
