import { createContext, use, useState } from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { chatImageStillId, chatImageUrl, findChatReplyImage, type ChatReplyImage, type ChatReplyImageError } from '@commando/agent-chat'
import { useTheme } from '../theme'
import { ImageViewer } from './ImageViewer'

/** The reply a Markdown image belongs to: its stored images, the daemon to load them from, and whether it still streams. */
export const ReplyImagesContext = createContext<{ images?: readonly ChatReplyImage[]; baseUrl?: string; running?: boolean }>({})

const NOTICES: Record<ChatReplyImageError | 'undrawable' | 'unresolved', string> = {
  missing: 'Image not found',
  unreadable: "Commando can't read this image (check its permissions)",
  unsupported: 'Not an image Commando can show',
  too_large: 'Image is too large to show',
  empty: 'Image file is empty',
  failed: "Commando couldn't store this image",
  undrawable: "Couldn't display this image",
  unresolved: "Image isn't available",
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function Notice({ reason, src }: { reason: keyof typeof NOTICES; src: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.notice, { borderColor: theme.borderStrong }]} accessible accessibilityLabel={`${NOTICES[reason]}: ${src}`}>
      <Feather name="image" size={13} color={theme.muted} />
      <Text selectable style={[styles.noticeText, { color: theme.muted }]}>{NOTICES[reason]}: {src}</Text>
    </View>
  )
}

/** An image drawn at the reply's width in its own shape; a tap opens it full screen. */
function ShownImage({ uri, alt, name }: { uri: string; alt: string; name: string }) {
  const theme = useTheme()
  const [ratio, setRatio] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  if (failed) return <Notice reason="undrawable" src={name} />
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={`Open ${alt || name}`} style={[styles.frame, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        <Image
          source={{ uri }}
          accessibilityLabel={alt || name}
          resizeMode="contain"
          style={[styles.image, { aspectRatio: ratio ?? 16 / 9 }]}
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source
            if (width > 0 && height > 0) setRatio(width / height)
          }}
          onError={() => setFailed(true)}
        />
      </Pressable>
      <ImageViewer image={open ? { uri, name: alt || name } : null} onClose={() => setOpen(false)} />
    </>
  )
}

/**
 * An image in an agent's reply. A local file shows once the daemon has stored
 * it, an SVG as the PNG the daemon draws of it (React Native can't draw SVG);
 * a web address loads as is; anything else is named, never a broken image.
 */
export function ReplyImage({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const theme = useTheme()
  const { images, baseUrl = '', running } = use(ReplyImagesContext)
  const image = findChatReplyImage(images, src)
  if (image && 'id' in image) return <ShownImage key={image.id} uri={`${baseUrl}${chatImageUrl(chatImageStillId(image.id))}`} alt={alt} name={fileName(image.src)} />
  if (image) return <Notice reason={image.error} src={image.src} />
  if (/^https?:\/\//i.test(src)) return <ShownImage key={src} uri={src} alt={alt} name={fileName(src)} />
  if (running) {
    return (
      <View style={[styles.notice, { borderColor: theme.borderStrong }]}>
        <ActivityIndicator size="small" color={theme.muted} />
        <Text style={[styles.noticeText, { color: theme.muted }]}>{alt || fileName(src)}</Text>
      </View>
    )
  }
  return <Notice reason="unresolved" src={src} />
}

const styles = StyleSheet.create({
  frame: { alignSelf: 'stretch', borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  image: { width: '100%', maxHeight: 420 },
  notice: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderStyle: 'dashed', borderRadius: 6 },
  noticeText: { flexShrink: 1, fontSize: 13 },
})
