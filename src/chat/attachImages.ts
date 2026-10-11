import {
  CHAT_IMAGE_EXTENSIONS,
  CHAT_IMAGE_MAX_DIMENSION,
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  type ChatImageType,
} from '../../shared/agent-chat'

// Browser-side resize before upload, after t3code's lib/imageCompression.ts (MIT).

/** Decoding a huge file can exhaust the tab, so very large sources are refused outright. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/** Tried in order when a resized image is still over the size limit. */
const JPEG_QUALITIES = [0.9, 0.8, 0.7] as const

export interface PreparedImage {
  blob: Blob
  name: string
  type: ChatImageType
}

export type PrepareResult = { ok: true; image: PreparedImage } | { ok: false; error: string }

/** The canvas work, swappable in tests (jsdom has no image decoder). */
export interface ImageCodec {
  size(file: Blob): Promise<{ width: number; height: number }>
  encode(file: Blob, width: number, height: number, type: ChatImageType, quality: number): Promise<Blob | null>
}

export const browserImageCodec: ImageCodec = {
  async size(file) {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  },
  async encode(file, width, height, type, quality) {
    const bitmap = await createImageBitmap(file)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return null
      if (type === 'image/jpeg') {
        // JPEG has no transparency; keep it from turning black.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
      }
      context.drawImage(bitmap, 0, 0, width, height)
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    } finally {
      bitmap.close()
    }
  },
}

export function isChatImageType(type: string): type is ChatImageType {
  return (CHAT_IMAGE_TYPES as readonly string[]).includes(type)
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

function renamed(name: string, type: ChatImageType): string {
  const base = name.replace(/\.[^./]+$/, '') || 'image'
  return `${base}.${CHAT_IMAGE_EXTENSIONS[type]}`
}

/**
 * Checks an image and shrinks it to at most 2000px on its longest edge.
 * Images already within both limits keep their exact bytes; GIFs are never
 * re-encoded, which would drop their animation.
 */
export async function prepareImage(file: File, codec: ImageCodec = browserImageCodec): Promise<PrepareResult> {
  const name = file.name || 'pasted image'
  if (!isChatImageType(file.type)) return { ok: false, error: `${name}: only PNG, JPEG, GIF and WebP images can be attached` }
  const tooLarge = (size: number): PrepareResult => ({ ok: false, error: `${name} is ${megabytes(size)}; images must be ${megabytes(MAX_CHAT_IMAGE_BYTES)} or smaller` })
  if (file.size > MAX_SOURCE_BYTES) return tooLarge(file.size)
  if (file.type === 'image/gif') return file.size > MAX_CHAT_IMAGE_BYTES ? tooLarge(file.size) : { ok: true, image: { blob: file, name, type: file.type } }
  let size: { width: number; height: number }
  try {
    size = await codec.size(file)
  } catch {
    return { ok: false, error: `${name} couldn't be read as an image` }
  }
  const longest = Math.max(size.width, size.height)
  if (longest <= CHAT_IMAGE_MAX_DIMENSION && file.size <= MAX_CHAT_IMAGE_BYTES) return { ok: true, image: { blob: file, name, type: file.type } }
  const scale = Math.min(1, CHAT_IMAGE_MAX_DIMENSION / longest)
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  // Keep the format first; fall back to JPEG when a big PNG or WebP still doesn't fit.
  const attempts: [ChatImageType, number][] = [[file.type, 0.92], ...JPEG_QUALITIES.map((quality): [ChatImageType, number] => ['image/jpeg', quality])]
  let smallest = Infinity
  for (const [type, quality] of attempts) {
    let blob: Blob | null
    try {
      blob = await codec.encode(file, width, height, type, quality)
    } catch {
      blob = null
    }
    if (!blob) continue
    if (blob.size <= MAX_CHAT_IMAGE_BYTES) return { ok: true, image: { blob, name: type === file.type ? name : renamed(name, type), type } }
    smallest = Math.min(smallest, blob.size)
  }
  return Number.isFinite(smallest) ? tooLarge(smallest) : { ok: false, error: `${name} couldn't be resized` }
}

/** How many of `adding` fit beside `current` attachments, and what to say about the rest. */
export function fitAttachments(current: number, adding: number): { accepted: number; error?: string } {
  const room = Math.max(0, MAX_CHAT_IMAGES - current)
  if (adding <= room) return { accepted: adding }
  return { accepted: room, error: `A message can carry at most ${MAX_CHAT_IMAGES} images` }
}
