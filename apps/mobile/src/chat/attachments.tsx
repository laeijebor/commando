import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { isChatVideoId, type ChatImageRef } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { showSheet } from './ComposerParts'
import { pickImages, prepareImage, takePhoto, uploadChatImage, type PickedImage } from './images'
import { VideoTile } from './VideoTile'

/** An image in a draft; `ref` arrives once it has been shrunk and uploaded. */
export type Attachment = { key: string; name: string; uri: string; ref?: ChatImageRef }

let attachmentCounter = 0
export function attachmentKey(prefix: string): string {
  attachmentCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${attachmentCounter}`
}

/**
 * A draft's images: picked or pasted ones join at once, then shrink and upload
 * behind a spinner. A failure drops the image and reports why.
 */
export function useAttachmentUploads(host: Host | undefined, onError: (error: string) => void, initial: () => Attachment[] = () => []) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const report = useRef(onError)
  report.current = onError

  const add = (images: readonly PickedImage[]) => {
    for (const image of images) {
      const key = attachmentKey('picked')
      setAttachments((current) => [...current, { key, name: image.name, uri: image.uri }])
      const drop = (error: string) => {
        if (!mounted.current) return
        setAttachments((current) => current.filter((attachment) => attachment.key !== key))
        report.current(error)
      }
      void (async () => {
        try {
          const prepared = await prepareImage(image)
          if (!prepared.ok) return drop(prepared.error)
          if (!host) return drop(`${image.name} didn't upload: the host is unknown`)
          const ref = await uploadChatImage(host, prepared.image)
          if (!mounted.current) return
          setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, name: prepared.image.name, uri: prepared.image.uri, ref } : attachment)))
        } catch (error) {
          drop(`${image.name} didn't upload: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }
  }

  const remove = (key: string) => setAttachments((current) => current.filter((attachment) => attachment.key !== key))

  return {
    attachments,
    setAttachments,
    add,
    remove,
    uploading: attachments.some((attachment) => !attachment.ref),
    refs: attachments.flatMap((attachment) => (attachment.ref ? [attachment.ref] : [])),
  }
}

/** The paperclip's choice of camera or library; null when cancelled. Errors say why nothing was picked. */
export async function pickFromSheet(anchor: View | null, room: number): Promise<PickedImage[] | null> {
  const choice = await showSheet(anchor, 'Attach images', ['Take Photo', 'Choose from Library'], -1)
  if (choice === null) return null
  return choice === 0 ? takePhoto() : pickImages(room)
}

/** The draft's thumbnails, each with a spinner until uploaded and a remove button. */
export function AttachmentStrip({ attachments, onRemove, style }: {
  attachments: readonly Attachment[]
  onRemove: (attachment: Attachment) => void
  style?: React.ComponentProps<typeof ScrollView>['contentContainerStyle']
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.strip, style]} keyboardShouldPersistTaps="always">
      {attachments.map((attachment) => (
        <View key={attachment.key} style={styles.thumb}>
          {attachment.ref && isChatVideoId(attachment.ref.id)
            ? <VideoTile name={attachment.name} style={styles.thumbImage} />
            : <Image accessibilityLabel={attachment.name} source={{ uri: attachment.uri }} style={[styles.thumbImage, { borderColor: theme.border }]} />}
          {attachment.ref ? null : (
            <View style={[styles.thumbBusy, { backgroundColor: withAlpha(theme.bg, 0.55) }]}>
              <ActivityIndicator color={theme.text} size="small" />
            </View>
          )}
          <Pressable
            accessibilityLabel={`Remove ${attachment.name}`}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => onRemove(attachment)}
            style={[styles.thumbRemove, { backgroundColor: theme.surfaceSoft, borderColor: theme.borderMid }]}
          >
            <Feather color={theme.text} name="x" size={11} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  strip: { gap: 8 },
  thumb: { width: 56, height: 56 },
  thumbImage: { width: 56, height: 56, borderRadius: 10, borderWidth: 1 },
  thumbBusy: { ...StyleSheet.absoluteFill, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  thumbRemove: { position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
})
