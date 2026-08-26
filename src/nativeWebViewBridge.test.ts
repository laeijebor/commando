// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  NATIVE_WEBVIEW_INSPECT_CAPABILITY,
  NATIVE_WEBVIEW_PAGE_RESPONSES_CAPABILITY,
  NATIVE_WEBVIEW_PROTOCOL,
  NATIVE_WEBVIEW_REVIEW_HIGHLIGHTS_CAPABILITY,
  NATIVE_WEBVIEW_REVIEW_INPUT_CAPABILITY,
  NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY,
  NativeWebViewBridge,
  type NativeWebViewTileEvent,
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

async function connect(
  bridge: NativeWebViewBridge,
  capabilities = ['webview.embed.v1'],
) {
  const pending = bridge.connect()
  receive(bridge, 1, 'bridge.connected', {
    capabilities,
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

  it('keeps inspection capabilities optional during negotiation', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    const pending = bridge.connect()
    receive(bridge, 1, 'bridge.connected', {
      capabilities: ['webview.embed.v1'],
      maxWebViews: 1,
    })
    await expect(pending).resolves.toMatchObject({ available: true })
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

    receive(bridge, 3, 'webview.loaded', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
    })
    expect(events).toEqual(['webview.attached', 'webview.loaded'])

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

  it('routes only bounded http(s) current URLs on loaded events', async () => {
    installHandler([])
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const events: NativeWebViewTileEvent[] = []
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', (event) => {
      events.push(event)
    })

    receive(bridge, 2, 'webview.loaded', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      url: 'https://example.com/after-navigation',
    })
    receive(bridge, 3, 'webview.loaded', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      url: 'file:///etc/passwd',
    })

    expect(events).toEqual([
      { type: 'webview.loaded', url: 'https://example.com/after-navigation' },
      { type: 'webview.loaded' },
    ])
  })

  it('opts capable attachments into page responses and routes validated answers', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge, ['webview.embed.v1', NATIVE_WEBVIEW_PAGE_RESPONSES_CAPABILITY])
    const events: NativeWebViewTileEvent[] = []
    const attachment = bridge.attach(
      'w-abcd1234',
      'https://example.com/review',
      (event) => events.push(event),
      { pageResponses: true },
    )

    expect(attachment.supportsPageResponses).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      type: 'webview.attach',
      payload: { pageResponses: true },
    })
    expect(attachment.presentPendingSnapshot('https://example.com/review', {
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Pro' },
      }],
    })).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      type: 'webview.presentPendingSnapshot',
      payload: { pageUrl: 'https://example.com/review', snapshot: { version: 1 } },
    })

    receive(bridge, 2, 'webview.pageResponse', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      url: 'https://example.com/review',
      responsePayload: JSON.stringify({
        question: 'Which plan?',
        answer: 'Team',
        queueKey: 'plan',
      }),
    })
    expect(events).toEqual([{
      type: 'webview.pageResponse',
      url: 'https://example.com/review',
      response: { question: 'Which plan?', answer: 'Team', queueKey: 'plan' },
    }])

    receive(bridge, 3, 'webview.pageResponse', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      url: 'file:///etc/passwd',
      responsePayload: JSON.stringify({ question: 'Ignored?', answer: 'Yes' }),
    })
    expect(events).toHaveLength(1)
  })

  it('does not expose page responses without explicit opt-in and capability', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const attachment = bridge.attach(
      'w-abcd1234',
      'https://example.com/',
      () => undefined,
      { pageResponses: true },
    )

    expect(attachment.supportsPageResponses).toBe(false)
    expect(messages.at(-1)?.payload).not.toHaveProperty('pageResponses')
    expect(attachment.presentPendingSnapshot('https://example.com/', { version: 1, controls: [] })).toBe(false)
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

  it('correlates and parses inspect and selector-resolution results', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge, [
      'webview.embed.v1',
      NATIVE_WEBVIEW_INSPECT_CAPABILITY,
      NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY,
      NATIVE_WEBVIEW_REVIEW_INPUT_CAPABILITY,
      NATIVE_WEBVIEW_REVIEW_HIGHLIGHTS_CAPABILITY,
    ])
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', () => undefined)
    expect(attachment.supportsReview).toBe(true)

    expect(attachment.setReviewInput(true)).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      type: 'webview.reviewInput',
      payload: { enabled: true },
    })
    expect(attachment.presentReviewHighlights([{
      kind: 'hover',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    }])).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      type: 'webview.presentReviewHighlights',
      payload: { highlights: [{ kind: 'hover', rect: { x: 1, y: 2, width: 3, height: 4 } }] },
    })

    const inspect = attachment.inspectAtPoint(12, 34, 'click')
    const inspectMessage = messages.at(-1)!
    expect(inspectMessage).toMatchObject({
      type: 'webview.inspectAtPoint',
      payload: { x: 12, y: 34, grade: 'click' },
    })
    const inspectRequestId = (inspectMessage.payload as Record<string, unknown>).requestId
    receive(bridge, 2, 'webview.inspectAtPoint.result', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      requestId: inspectRequestId,
      result: {
        ok: true,
        selector: '#target',
        tag: 'button',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        text: 'Target',
      },
    })
    await expect(inspect).resolves.toEqual({
      ok: true,
      selector: '#target',
      tag: 'button',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 'Target',
    })

    const resolved = attachment.resolveSelectors([{ noteId: 7, selector: '#target' }])
    const resolveMessage = messages.at(-1)!
    expect(resolveMessage).toMatchObject({
      type: 'webview.resolveSelectors',
      payload: { items: [{ noteId: 7, selector: '#target' }] },
    })
    const resolveRequestId = (resolveMessage.payload as Record<string, unknown>).requestId
    receive(bridge, 3, 'webview.resolveSelectors.result', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      requestId: resolveRequestId,
      ok: true,
      anchors: [{ noteId: 7, rect: { x: 5, y: 6, width: 7, height: 8 } }],
    })
    await expect(resolved).resolves.toEqual([
      { noteId: 7, rect: { x: 5, y: 6, width: 7, height: 8 } },
    ])
  })

  it('rejects unsupported and malformed inspection requests before posting', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', () => undefined)
    const count = messages.length

    await expect(attachment.inspectAtPoint(1, 2, 'hover')).rejects.toThrow('not supported')
    await expect(attachment.resolveSelectors([{ noteId: 1, selector: '#target' }]))
      .rejects.toThrow('not supported')
    expect(messages).toHaveLength(count)
  })

  it('rejects review input and invalid highlight presentations without capabilities or posts', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge)
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', () => undefined)
    const count = messages.length

    expect(attachment.supportsReview).toBe(false)
    expect(attachment.setReviewInput(true)).toBe(false)
    expect(attachment.presentReviewHighlights([])).toBe(false)
    expect(messages).toHaveLength(count)

    attachment.detach()

    const capable = new NativeWebViewBridge()
    await connect(capable, [
      'webview.embed.v1',
      NATIVE_WEBVIEW_INSPECT_CAPABILITY,
      NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY,
      NATIVE_WEBVIEW_REVIEW_INPUT_CAPABILITY,
      NATIVE_WEBVIEW_REVIEW_HIGHLIGHTS_CAPABILITY,
    ])
    const capableAttachment = capable.attach('w-abcd1234', 'https://example.com/', () => undefined)
    const capableCount = messages.length
    expect(capableAttachment.presentReviewHighlights([{
      kind: 'annotation',
      rect: { x: 0, y: 0, width: -1, height: 2 },
    }])).toBe(false)
    expect(messages).toHaveLength(capableCount)
    capable.dispose()
  })

  it('bounds selector batches and rejects pending work when detached', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge, [
      'webview.embed.v1',
      NATIVE_WEBVIEW_INSPECT_CAPABILITY,
      NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY,
    ])
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', () => undefined)

    await expect(attachment.inspectAtPoint(-1, 2, 'hover')).rejects.toThrow('Invalid')
    await expect(attachment.resolveSelectors([
      { noteId: 1, selector: '#one' },
      { noteId: 1, selector: '#duplicate' },
    ])).rejects.toThrow('Invalid')
    await expect(attachment.resolveSelectors([
      { noteId: 2, selector: 'x'.repeat(1_025) },
    ])).rejects.toThrow('Invalid')

    const pending = attachment.inspectAtPoint(1, 2, 'hover')
    attachment.detach()
    await expect(pending).rejects.toThrow('detached')
  })

  it('rejects invalid or unrequested correlated results', async () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWebViewBridge()
    await connect(bridge, [
      'webview.embed.v1',
      NATIVE_WEBVIEW_INSPECT_CAPABILITY,
      NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY,
    ])
    const attachment = bridge.attach('w-abcd1234', 'https://example.com/', () => undefined)

    const inspect = attachment.inspectAtPoint(1, 2, 'hover')
    const inspectRequestId = (messages.at(-1)!.payload as Record<string, unknown>).requestId
    receive(bridge, 2, 'webview.inspectAtPoint.result', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      requestId: inspectRequestId,
      result: { ok: true },
    })
    await expect(inspect).rejects.toThrow('invalid inspection result')

    const resolved = attachment.resolveSelectors([{ noteId: 4, selector: '#target' }])
    const resolveRequestId = (messages.at(-1)!.payload as Record<string, unknown>).requestId
    receive(bridge, 3, 'webview.resolveSelectors.result', {
      webPaneId: 'w-abcd1234',
      attachmentId: attachment.attachmentId,
      requestId: resolveRequestId,
      ok: true,
      anchors: [{ noteId: 99, rect: { x: 1, y: 2, width: 3, height: 4 } }],
    })
    await expect(resolved).rejects.toThrow('invalid selector anchors')
  })
})
