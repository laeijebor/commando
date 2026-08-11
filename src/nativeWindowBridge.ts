import { useEffect, useState } from 'react'

export const NATIVE_WINDOW_PROTOCOL = 'commando.native-window' as const
export const NATIVE_WINDOW_VERSION = 1 as const
export const MAX_NATIVE_CLIPBOARD_TEXT = 65_536
export const DETACHED_WEB_PANES_EVENT = 'commando:desktop-detached-web-panes'

type NativeMessageHandler = {
  postMessage: (message: Record<string, unknown>) => void
}

type DesktopWindowRole =
  | { kind: 'workspace' }
  | { kind: 'web-pane'; webPaneId: string }

declare global {
  interface Window {
    __commandoDesktopWindowRole?: DesktopWindowRole
    __commandoDetachedWebPaneIds?: string[]
  }
}

function isWebPaneId(value: unknown): value is string {
  return typeof value === 'string' && /^w-[0-9a-f]{8}$/i.test(value)
}

function detachedIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter(isWebPaneId))
}

function messageHandler(): NativeMessageHandler | null {
  try {
    const handler = (window as unknown as {
      webkit?: { messageHandlers?: { commandoNativeWindow?: NativeMessageHandler } }
    }).webkit?.messageHandlers?.commandoNativeWindow
    return handler && typeof handler.postMessage === 'function' ? handler : null
  } catch {
    return null
  }
}

function clipboardMessageHandler(): NativeMessageHandler | null {
  try {
    const handler = (window as unknown as {
      webkit?: { messageHandlers?: { commandoNativeClipboard?: NativeMessageHandler } }
    }).webkit?.messageHandlers?.commandoNativeClipboard
    return handler && typeof handler.postMessage === 'function' ? handler : null
  } catch {
    return null
  }
}

export function hasNativeWindowHandler(): boolean {
  return messageHandler() !== null
}

export function hasNativeClipboardHandler(): boolean {
  return clipboardMessageHandler() !== null
}

export class NativeWindowBridge {
  open(webPaneId: string): boolean {
    return isWebPaneId(webPaneId) && this.post('web-pane.open', { webPaneId })
  }

  focus(webPaneId: string): boolean {
    return isWebPaneId(webPaneId) && this.post('web-pane.focus', { webPaneId })
  }

  reattach(webPaneId: string): boolean {
    return isWebPaneId(webPaneId) && this.post('web-pane.reattach', { webPaneId })
  }

  writeClipboardText(text: string): boolean {
    if (text.length === 0 || text.length > MAX_NATIVE_CLIPBOARD_TEXT) return false
    const handler = clipboardMessageHandler()
    if (!handler) return false
    try {
      handler.postMessage({
        protocol: NATIVE_WINDOW_PROTOCOL,
        version: NATIVE_WINDOW_VERSION,
        type: 'clipboard.write-text',
        payload: { text },
      })
      return true
    } catch {
      return false
    }
  }

  private post(type: string, payload: Record<string, unknown>): boolean {
    const handler = messageHandler()
    if (!handler) return false
    try {
      handler.postMessage({
        protocol: NATIVE_WINDOW_PROTOCOL,
        version: NATIVE_WINDOW_VERSION,
        type,
        payload,
      })
      return true
    } catch {
      return false
    }
  }
}

let sharedBridge: NativeWindowBridge | undefined

export function getNativeWindowBridge(): NativeWindowBridge | null {
  if (!hasNativeWindowHandler()) return null
  sharedBridge ??= new NativeWindowBridge()
  return sharedBridge
}

export function resetNativeWindowBridge(): void {
  sharedBridge = undefined
}

export function useDetachedWebPaneIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<Set<string>>(
    () => detachedIds(window.__commandoDetachedWebPaneIds),
  )

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      const next = detachedIds(detail)
      window.__commandoDetachedWebPaneIds = [...next]
      setIds(next)
    }
    window.addEventListener(DETACHED_WEB_PANES_EVENT, update)
    return () => window.removeEventListener(DETACHED_WEB_PANES_EVENT, update)
  }, [])

  return ids
}

export function detachedWebPaneIdFromLocation(
  location: Pick<Location, 'search'> = window.location,
): string | null {
  const params = new URLSearchParams(location.search)
  if (params.get('commandoWindow') !== 'web-pane') return null
  const webPaneId = params.get('webPaneId')
  return isWebPaneId(webPaneId) ? webPaneId : null
}
