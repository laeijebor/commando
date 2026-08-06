// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  NATIVE_WEBVIEW_PROTOCOL,
  NativeWebViewBridge,
  resetNativeWebViewBridge,
  getNativeWebViewBridge,
  hasNativeWebViewHandler,
} from './nativeWebViewBridge'

type PostedMessage = Record<string, unknown>

function installHandler(messages: PostedMessage[]) {
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        commandoNativeWebView: {
          postMessage: (message: PostedMessage) => messages.push(message),
        },
      },
    },
  })
}

function receive(bridge: NativeWebViewBridge, eventSequence: number, type: string, payload: object) {
  window.__commandoNativeWebViewReceive?.({
    version: 1,
    pageId: bridge.pageId,
    eventSequence,
    type,
    payload,
  })
}

async function connect(bridge: NativeWebViewBridge) {
  const pending = bridge.connect()
  receive(bridge, 1, 'bridge.connected', {
    capabilities: ['webview.embed.v1'],
    maxWebViews: 4,
  })
  await expect(pending).resolves.toMatchObject({ available: true, maxWebViews: 4 })
}

beforeEach(() => {
  resetNativeWebViewBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeWebViewReceive
})

afterEach(() => {
  resetNativeWebViewBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  delete window.__commandoNativeWebViewReceive
})

describe('NativeWebViewBridge', () => {
  it('is unavailable without the desktop shell handler', async () => {
    expect(hasNativeWebViewHandler()).toBe(false)
    expect(getNativeWebViewBridge()).toBeNull()
    const bridge = new NativeWebViewBridge()
    await expect(bridge.connect()).resolves.toEqual({
      available: false,
      reason: 'handler-absent',
    })
  })

  it('negotiates with the versioned envelope and required capability', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()

    const pending = bridge.connect()
    expect(messages).toEqual([{
      protocol: NATIVE_WEBVIEW_PROTOCOL,
      version: 1,
      pageId: bridge.pageId,
      sequence: 1,
      type: 'bridge.connect',
      payload: { supportedVersions: [1] },
    }])

    receive(bridge, 1, 'bridge.connected', {
      capabilities: ['webview.embed.v1', 'webview.extra.v1'],
      maxWebViews: 3,
    })
    await expect(pending).resolves.toMatchObject({ available: true, maxWebViews: 3 })
  })

  it('rejects a host missing the embed capability', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    const pending = bridge.connect()
    receive(bridge, 1, 'bridge.connected', { capabilities: [], maxWebViews: 3 })
    await expect(pending).resolves.toEqual({
      available: false,
      reason: 'missing-capabilities',
    })
  })

  it('attaches, frames, reloads, and detaches a tile', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge)

    const events: string[] = []
    const attachment = bridge.attach('w-abcd1234', 'https://reactnative.dev/docs', (event) => {
      events.push(event.type)
    })
    const attachMessage = messages.at(-1)!
    expect(attachMessage).toMatchObject({
      type: 'webview.attach',
      payload: {
        webPaneId: 'w-abcd1234',
        attachmentId: attachment.attachmentId,
        url: 'https://reactnative.dev/docs',
      },
    })

    receive(bridge, 2, 'webview.attached', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
    })
    expect(events).toEqual(['webview.attached'])

    expect(bridge.frame(attachment.attachmentId, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      scale: 2,
      visible: true,
      visibleRegions: [{ x: 10, y: 20, width: 300, height: 200 }],
      resizeOwner: false,
      order: 0,
    })).toBe(true)
    expect(messages.at(-1)).toMatchObject({ type: 'webview.frame' })

    expect(bridge.reload(attachment.attachmentId)).toBe(true)
    expect(messages.at(-1)).toMatchObject({ type: 'webview.reload' })

    attachment.detach()
    expect(messages.at(-1)).toMatchObject({ type: 'webview.detach' })
    // A second detach posts nothing.
    const count = messages.length
    attachment.detach()
    expect(messages).toHaveLength(count)
  })

  it('routes failure events to the tile listener', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const events: Array<{ type: string; code?: string }> = []
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', (event) => {
      events.push(event)
    })

    receive(bridge, 2, 'webview.failed', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      code: 'load_failed',
    })
    expect(events).toEqual([{ type: 'webview.failed', code: 'load_failed' }])
  })

  it('ignores stale and mismatched events', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const events: string[] = []
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', (event) => {
      events.push(event.type)
    })

    // Wrong web pane id for the attachment.
    receive(bridge, 2, 'webview.failed', {
      webPaneId: 'w-other',
      attachmentId: attachment.attachmentId,
      code: 'load_failed',
    })
    // Replayed sequence.
    receive(bridge, 2, 'webview.attached', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
    })
    expect(events).toEqual([])
  })

  it('refuses to frame an unknown attachment', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    expect(bridge.frame('missing', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      scale: 1,
      visible: true,
      visibleRegions: [],
      resizeOwner: false,
      order: 0,
    })).toBe(false)
  })
})
