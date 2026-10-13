import { requireOptionalNativeModule } from 'expo'

import {
  CHAT_IMAGE_MAX_DIMENSION,
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  isChatImageId,
  type ChatImageRef,
  type ChatImageType,
} from '@commando/agent-chat'

import { authHeaders } from '../hosts/api'
import type { Host } from '../hosts/types'

/** A photo picked from the library, before it is checked and shrunk. */
export type PickedImage = { uri: string; name: string; type: string; width: number; height: number; size?: number }

/** What goes up to `/api/chat/images`. */
export type PreparedImage = { uri: string; name: string; type: ChatImageType }

type ImagePickerModule = typeof import('expo-image-picker')
type ImageManipulatorModule = typeof import('expo-image-manipulator')

/**
 * The picker and the resizer are native modules. A dev client built before
 * they were added doesn't have them, so they load on first use and the
 * composer says to rebuild rather than crashing the chat. The native module is
 * checked first: requiring the package without it throws inside Metro's module
 * loader, which reports a fatal error before any catch here could see it.
 */
function load<T>(name: 'picker' | 'manipulator'): T | null {
  if (!requireOptionalNativeModule(name === 'picker' ? 'ExponentImagePicker' : 'ExpoImageManipulator')) return null
  return (name === 'picker' ? require('expo-image-picker') : require('expo-image-manipulator')) as T
}

export const REBUILD_FOR_IMAGES = 'This build of the app has no photo picker; rebuild it to attach images'

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

export function isChatImageType(type: string): type is ChatImageType {
  return (CHAT_IMAGE_TYPES as readonly string[]).includes(type)
}

/** Opens the photo library for up to `limit` images. Null when it was cancelled. */
export async function pickImages(limit: number): Promise<PickedImage[] | null> {
  const picker = load<ImagePickerModule>('picker')
  if (!picker) throw new Error(REBUILD_FOR_IMAGES)
  const result = await picker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    // The library hands HEIC photos over as JPEG, which Claude reads.
    preferredAssetRepresentationMode: picker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1,
  })
  if (result.canceled) return null
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName || `photo-${index + 1}.jpg`,
    type: asset.mimeType ?? 'image/jpeg',
    width: asset.width,
    height: asset.height,
    ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
  }))
}

function renamed(name: string, type: ChatImageType): string {
  const base = name.replace(/\.[^./]+$/, '') || 'image'
  return `${base}.${type === 'image/png' ? 'png' : 'jpg'}`
}

/**
 * Checks a picked image and shrinks it to 2000px on its longest edge, as the
 * web's prepareImage does in the browser. Images within both limits keep
 * their bytes; GIFs are never re-encoded, which would drop their animation.
 */
export async function prepareImage(image: PickedImage): Promise<{ ok: true; image: PreparedImage } | { ok: false; error: string }> {
  if (!isChatImageType(image.type)) return { ok: false, error: `${image.name}: only PNG, JPEG, GIF and WebP images can be attached` }
  const fits = image.size === undefined || image.size <= MAX_CHAT_IMAGE_BYTES
  const longest = Math.max(image.width, image.height)
  if (image.type === 'image/gif' || (fits && longest <= CHAT_IMAGE_MAX_DIMENSION)) {
    return fits
      ? { ok: true, image: { uri: image.uri, name: image.name, type: image.type } }
      : { ok: false, error: `${image.name} is ${megabytes(image.size!)}; images must be ${megabytes(MAX_CHAT_IMAGE_BYTES)} or smaller` }
  }
  const manipulator = load<ImageManipulatorModule>('manipulator')
  if (!manipulator) return { ok: false, error: REBUILD_FOR_IMAGES }
  const scale = longest > 0 ? Math.min(1, CHAT_IMAGE_MAX_DIMENSION / longest) : 1
  // Keep PNG (screenshots); everything else becomes JPEG, as the web's fallback does.
  const type: ChatImageType = image.type === 'image/png' ? 'image/png' : 'image/jpeg'
  try {
    const context = manipulator.ImageManipulator.manipulate(image.uri)
    if (scale < 1) context.resize({ width: Math.max(1, Math.round(image.width * scale)) })
    const rendered = await context.renderAsync()
    // Keep the format first; a big photo-like PNG falls back to JPEG, as the web's does.
    const attempts: [ChatImageType, number][] = [[type, 0.9], ['image/jpeg', 0.8], ['image/jpeg', 0.7]]
    let smallest = Infinity
    for (const [format, compress] of attempts) {
      const saved = await rendered.saveAsync({ format: format === 'image/png' ? manipulator.SaveFormat.PNG : manipulator.SaveFormat.JPEG, compress })
      const size = await fileSize(saved.uri)
      if (size <= MAX_CHAT_IMAGE_BYTES) return { ok: true, image: { uri: saved.uri, name: renamed(image.name, format), type: format } }
      smallest = Math.min(smallest, size)
    }
    return { ok: false, error: `${image.name} is ${megabytes(smallest)} even resized; images must be ${megabytes(MAX_CHAT_IMAGE_BYTES)} or smaller` }
  } catch (error) {
    return { ok: false, error: `${image.name} couldn't be resized: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function fileSize(uri: string): Promise<number> {
  return (await (await fetch(uri)).blob()).size
}

/** How long an upload may take before the composer gives up on it. */
const UPLOAD_TIMEOUT_MS = 60_000

/** Uploads one image the way the web composer does; the message then names it by id. */
export async function uploadChatImage(host: Host, image: PreparedImage, fetcher: typeof fetch = fetch): Promise<ChatImageRef> {
  let blob: Blob
  try {
    blob = await (await fetcher(image.uri)).blob()
  } catch {
    throw new Error("couldn't read the picked image; pick it again")
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetcher(`${host.baseUrl}/api/chat/images`, {
      method: 'POST',
      body: blob,
      credentials: 'include',
      headers: { 'Content-Type': image.type, ...authHeaders(host) },
      signal: controller.signal,
    })
  } catch (error) {
    throw controller.signal.aborted ? new Error('the upload timed out') : error
  } finally {
    clearTimeout(timer)
  }
  const result = await response.json().catch(() => ({})) as { image?: { id?: unknown }; error?: string }
  if (!response.ok || !isChatImageId(result.image?.id)) throw new Error(result.error ?? `Upload failed (${response.status})`)
  return { id: result.image.id, name: image.name }
}
