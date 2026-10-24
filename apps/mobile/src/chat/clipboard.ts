import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Clipboard from 'expo-clipboard'

import type { PickedImage } from './images'

/** The image half of what the clipboard hands over: a base64 data URI and its pixel size. */
export type ClipboardImageData = { data: string; size: { width: number; height: number } }

/** Bytes behind a base64 data URI, without decoding it. */
export function dataUriBytes(uri: string): number {
  const base64 = uri.slice(uri.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A clipboard image as the composer's picked-image shape, so it goes through
 * the same checks, resize and upload as a photo from the library.
 */
export function pastedImage(image: ClipboardImageData, now = new Date()): PickedImage | null {
  const match = /^data:(image\/[a-z+.-]+);base64,/i.exec(image.data)
  if (!match) return null
  const type = match[1]!.toLowerCase()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return {
    uri: image.data,
    name: `pasted-${stamp}.${type === 'image/png' ? 'png' : 'jpg'}`,
    type,
    width: image.size.width,
    height: image.size.height,
    size: dataUriBytes(image.data),
  }
}

/**
 * Whether the clipboard holds an image. `hasImageAsync` only asks the
 * pasteboard what it holds, so it never shows iOS's "Allow Paste" prompt.
 * iOS doesn't report another app's copy while this one is in the background,
 * so the check runs again whenever the app comes back to the front.
 *
 * `dismiss` hides the offer until the clipboard is seen to change: after a
 * paste, or when the user waves it away.
 */
export function useClipboardImage(enabled: boolean): { available: boolean; recheck: () => void; dismiss: () => void } {
  const [hasImage, setHasImage] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [checks, setChecks] = useState(0)
  const recheck = useCallback(() => setChecks((count) => count + 1), [])
  const lastState = useRef(AppState.currentState)

  useEffect(() => {
    if (!enabled) return
    let current = true
    Clipboard.hasImageAsync().then((value) => { if (current) setHasImage(value) }, () => { if (current) setHasImage(false) })
    return () => { current = false }
  }, [enabled, checks])

  useEffect(() => {
    if (!enabled) return
    // A copy made elsewhere is a new clipboard: offer it again. Only a return
    // from the background can bring one; Control Center or a banner only
    // makes the app inactive for a moment.
    const appState = AppState.addEventListener('change', (state) => {
      const from = lastState.current
      lastState.current = state
      if (state !== 'active') return
      if (from === 'background') setDismissed(false)
      recheck()
    })
    const clipboard = Clipboard.addClipboardListener(() => { setDismissed(false); recheck() })
    return () => {
      appState.remove()
      clipboard.remove()
    }
  }, [enabled, recheck])

  return { available: enabled && hasImage && !dismissed, recheck, dismiss: useCallback(() => setDismissed(true), []) }
}

/** iOS 16's paste control reads the clipboard without the "Allow Paste" prompt. */
export function pasteButtonAvailable(): boolean {
  return Clipboard.isPasteButtonAvailable
}

/** The fallback for older iOS: reading the image asks the user for permission first. */
export async function readClipboardImage(): Promise<ClipboardImageData | null> {
  return Clipboard.getImageAsync({ format: 'png' })
}
