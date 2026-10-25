import type { ChatImageRef } from '@commando/agent-chat'

/** Images "uploaded" to the demo host stay on the phone; their ids point back at the local file. */
const stored = new Map<string, string>()

let counter = 0
function demoImageId(ext: string): string {
  counter += 1
  const seed = `${Date.now().toString(16)}${counter.toString(16)}`
  return `${seed.padStart(64, '0').slice(-64)}.${ext}`
}

export function demoUploadImage(image: { uri: string; name: string; type: string }): ChatImageRef {
  const ext = image.type === 'image/png' ? 'png' : image.type === 'image/gif' ? 'gif' : image.type === 'image/webp' ? 'webp' : 'jpg'
  const id = demoImageId(ext)
  stored.set(id, image.uri)
  return { id, name: image.name }
}

export function demoImageUri(id: string): string | undefined {
  return stored.get(id)
}
