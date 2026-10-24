import { Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import { ClipboardPasteButton } from 'expo-clipboard'

import { useTheme } from '../theme'
import { IconButton } from './ComposerParts'
import { pasteButtonAvailable, readClipboardImage, type ClipboardImageData } from './clipboard'

/**
 * The offer to paste the clipboard's image, shown while it holds one. A plain
 * TextInput's own Paste menu only takes text, so images come in here: through
 * iOS's paste control where there is one (no "Allow Paste" prompt), or a button
 * that reads the clipboard after the system asks.
 */
export function PasteImageBar({ onImage, onError, onDismiss }: {
  onImage: (image: ClipboardImageData) => void
  onError: (message: string) => void
  onDismiss: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fallback = async () => {
    try {
      const image = await readClipboardImage()
      if (image) onImage(image)
      else onError('The clipboard no longer holds an image')
    } catch (error) {
      onError(`Couldn't read the clipboard: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <View style={[styles.bar, { borderColor: theme.border }]} testID="chat-paste-image">
      <Feather color={theme.muted} name="image" size={14} />
      <Text numberOfLines={1} style={[styles.label, { color: theme.textSoft }]}>Image on the clipboard</Text>
      {pasteButtonAvailable ? (
        <ClipboardPasteButton
          accessibilityLabel="Paste image"
          acceptedContentTypes={['image']}
          backgroundColor={theme.accent}
          cornerStyle="capsule"
          displayMode="iconAndLabel"
          foregroundColor={theme.accentInk}
          imageOptions={{ format: 'png' }}
          onPress={(data) => {
            if (data.type === 'image') onImage(data)
            else onError('The clipboard no longer holds an image')
          }}
          style={styles.control}
        />
      ) : (
        <Pressable
          accessibilityLabel="Paste image"
          accessibilityRole="button"
          onPress={() => void fallback()}
          style={[styles.control, styles.fallback, { backgroundColor: theme.accent }]}
        >
          <Feather color={theme.accentInk} name="clipboard" size={13} />
          <Text style={[styles.fallbackText, { color: theme.accentInk }]}>Paste</Text>
        </Pressable>
      )}
      <IconButton icon="x" label="Hide paste image" onPress={onDismiss} />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginTop: 8, paddingLeft: 10, paddingVertical: 4, paddingRight: 2, borderWidth: 1, borderRadius: 14 },
  label: { flex: 1, fontSize: 13 },
  control: { width: 92, height: 30 },
  fallback: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 15 },
  fallbackText: { fontSize: 13, fontWeight: '600' },
})
