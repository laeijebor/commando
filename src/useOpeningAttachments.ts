import { useEffect, useRef, useState } from 'react'
import { MAX_CHAT_VIDEO_BYTES, type ChatImageRef } from '../shared/agent-chat'
import { fitAttachments } from '../shared/chat-composer'
import { prepareImage, type PreparedImage } from './chat/attachImages'

export type OpeningAttachment = { key: string; name: string; previewUrl: string; video: boolean; ref?: ChatImageRef }

export type AttachmentUploads = {
  uploadImage: (image: PreparedImage) => Promise<ChatImageRef>
  uploadVideo: (file: File, signal?: AbortSignal) => Promise<ChatImageRef>
}

export const isVideoFile = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/iu.test(file.name)
export const isAttachableFile = (file: File) => file.type.startsWith('image/') || isVideoFile(file)

/**
 * Images and videos pasted into the New session prompt. Each uploads as soon as it is
 * added, like the chat composer's, so the session starts the moment you press create.
 */
export function useOpeningAttachments(uploads: AttachmentUploads) {
  const [attachments, setAttachments] = useState<OpeningAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const previews = useRef(new Set<string>())
  const videoUploads = useRef(new Map<string, AbortController>())
  const latest = useRef(attachments)
  latest.current = attachments

  useEffect(() => () => {
    for (const upload of videoUploads.current.values()) upload.abort()
    for (const url of previews.current) URL.revokeObjectURL(url)
  }, [])

  const release = (attachment: OpeningAttachment) => {
    videoUploads.current.get(attachment.key)?.abort()
    videoUploads.current.delete(attachment.key)
    URL.revokeObjectURL(attachment.previewUrl)
    previews.current.delete(attachment.previewUrl)
  }

  const remove = (key: string) => {
    setError(null)
    setAttachments((current) => current.filter((attachment) => {
      if (attachment.key === key) release(attachment)
      return attachment.key !== key
    }))
  }

  const add = (files: File[]) => {
    const incoming = files.filter(isAttachableFile)
    if (!incoming.length) return
    const tooBig = incoming.some((file) => isVideoFile(file) && file.size > MAX_CHAT_VIDEO_BYTES)
    const sized = incoming.filter((file) => !isVideoFile(file) || file.size <= MAX_CHAT_VIDEO_BYTES)
    const fit = fitAttachments(latest.current.length, sized.length)
    setError(tooBig ? `Videos must be ${MAX_CHAT_VIDEO_BYTES / 1024 / 1024} MB or smaller` : fit.error ?? null)
    for (const file of sized.slice(0, fit.accepted)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const previewUrl = URL.createObjectURL(file)
      previews.current.add(previewUrl)
      const video = isVideoFile(file)
      const name = file.name || (video ? 'pasted video' : 'pasted image')
      setAttachments((current) => [...current, { key, name, previewUrl, video }])
      const settle = (ref: ChatImageRef) => setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, name: ref.name ?? attachment.name, ref } : attachment)))
      const drop = (message: string) => {
        setAttachments((current) => current.filter((attachment) => {
          if (attachment.key === key) release(attachment)
          return attachment.key !== key
        }))
        setError(message)
      }
      void (async () => {
        if (video) {
          const upload = new AbortController()
          videoUploads.current.set(key, upload)
          try {
            settle(await uploads.uploadVideo(file, upload.signal))
          } catch (cause) {
            // Removed while it uploaded: nothing to report.
            if (!upload.signal.aborted) drop(`${name} didn't upload: ${cause instanceof Error ? cause.message : String(cause)}`)
          } finally {
            videoUploads.current.delete(key)
          }
          return
        }
        const prepared = await prepareImage(file)
        if (!prepared.ok) return drop(prepared.error)
        try {
          settle(await uploads.uploadImage(prepared.image))
        } catch (cause) {
          drop(`${name} didn't upload: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })()
    }
  }

  const clear = () => {
    for (const attachment of latest.current) release(attachment)
    setAttachments([])
    setError(null)
  }

  return {
    attachments,
    error,
    dismissError: () => setError(null),
    add,
    remove,
    clear,
    uploading: attachments.some((attachment) => !attachment.ref),
    refs: attachments.flatMap((attachment) => (attachment.ref ? [attachment.ref] : [])),
  }
}
