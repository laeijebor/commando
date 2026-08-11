// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DETACHED_WEB_PANES_EVENT,
  MAX_NATIVE_CLIPBOARD_TEXT,
  NATIVE_WINDOW_PROTOCOL,
  NativeWindowBridge,
  detachedWebPaneIdFromLocation,
  getNativeWindowBridge,
  hasNativeWindowHandler,
  resetNativeWindowBridge,
  useDetachedWebPaneIds,
} from './nativeWindowBridge'

type PostedMessage = Record<string, unknown>

function installHandler(messages: PostedMessage[]) {
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        commandoNativeWindow: {
          postMessage: (message: PostedMessage) => messages.push(message),
        },
      },
    },
  })
}

function DetachedIds() {
  const ids = useDetachedWebPaneIds()
  return <output>{[...ids].join(',')}</output>
}

beforeEach(() => {
  resetNativeWindowBridge()
  delete window.__commandoDetachedWebPaneIds
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
})

afterEach(() => {
  cleanup()
  resetNativeWindowBridge()
  delete window.__commandoDetachedWebPaneIds
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
})

describe('NativeWindowBridge', () => {
  it('is absent in ordinary browser clients', () => {
    expect(hasNativeWindowHandler()).toBe(false)
    expect(getNativeWindowBridge()).toBeNull()
  })

  it('posts bounded versioned open, focus, and reattach commands', () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWindowBridge()

    expect(bridge.open('w-abcd1234')).toBe(true)
    expect(bridge.focus('w-abcd1234')).toBe(true)
    expect(bridge.reattach('w-abcd1234')).toBe(true)
    expect(bridge.open('../../bad')).toBe(false)
    expect(messages).toEqual([
      {
        protocol: NATIVE_WINDOW_PROTOCOL,
        version: 1,
        type: 'web-pane.open',
        payload: { webPaneId: 'w-abcd1234' },
      },
      expect.objectContaining({ type: 'web-pane.focus' }),
      expect.objectContaining({ type: 'web-pane.reattach' }),
    ])
  })

  it('posts only bounded nonempty clipboard text', () => {
    const messages: PostedMessage[] = []
    installHandler(messages)
    const bridge = new NativeWindowBridge()

    expect(bridge.writeClipboardText(' exact\nselection ')).toBe(true)
    expect(bridge.writeClipboardText('')).toBe(false)
    expect(bridge.writeClipboardText('x'.repeat(MAX_NATIVE_CLIPBOARD_TEXT + 1))).toBe(false)
    expect(messages).toEqual([expect.objectContaining({
      type: 'clipboard.write-text',
      payload: { text: ' exact\nselection ' },
    })])
  })

  it('tracks authoritative detached ids published by AppKit', () => {
    window.__commandoDetachedWebPaneIds = ['w-abcd1234']
    render(<DetachedIds />)
    expect(screen.getByText('w-abcd1234')).toBeInTheDocument()

    act(() => window.dispatchEvent(new CustomEvent(DETACHED_WEB_PANES_EVENT, {
      detail: ['bad', 'w-deadbeef'],
    })))
    expect(screen.getByText('w-deadbeef')).toBeInTheDocument()
  })

  it('recognizes only a valid native focused-window query', () => {
    expect(detachedWebPaneIdFromLocation({
      search: '?commandoWindow=web-pane&webPaneId=w-abcd1234',
    })).toBe('w-abcd1234')
    expect(detachedWebPaneIdFromLocation({
      search: '?commandoWindow=web-pane&webPaneId=bad',
    })).toBeNull()
    expect(detachedWebPaneIdFromLocation({ search: '?webPaneId=w-abcd1234' })).toBeNull()
  })
})
