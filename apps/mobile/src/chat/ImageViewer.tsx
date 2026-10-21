import { use, useRef, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type GestureResponderEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

export type ViewableImage = { uri: string; name: string }

const MAX_ZOOM = 8
const DOUBLE_TAP_MS = 280

/** The size an image opens at: as large as fits the screen. */
export function fitImage(natural: { w: number; h: number } | null, room: { w: number; h: number }): { w: number; h: number } {
  if (!natural || natural.w <= 0 || natural.h <= 0) return { w: room.w, h: room.w * 0.75 }
  const factor = Math.min(room.w / natural.w, room.h / natural.h)
  return { w: natural.w * factor, h: natural.h * factor }
}

/**
 * A full-screen image: pinch to zoom (iOS's own scroll-view zoom), drag to
 * pan, double-tap to zoom in or back out. A tap beside the image, or the
 * close button, closes it.
 */
export function ImageViewer({ image, onClose }: { image: ViewableImage | null; onClose: () => void }): React.JSX.Element {
  return (
    <Modal visible={image !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      {image ? <ZoomableImage key={image.uri} image={image} onClose={onClose} /> : null}
    </Modal>
  )
}

function ZoomableImage({ image, onClose }: { image: ViewableImage; onClose: () => void }) {
  const { width, height } = useWindowDimensions()
  // The app's root provides insets; a test without it gets none rather than a throw.
  const insets = use(SafeAreaInsetsContext) ?? NO_INSETS
  const scroll = useRef<ScrollView>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const zoom = useRef(1)
  const lastTap = useRef(0)
  const fitted = fitImage(natural, { w: width, h: height - insets.top - insets.bottom - 88 })

  const zoomTo = (rect: { x: number; y: number; width: number; height: number }) => {
    // iOS zooms the scroll view to a rectangle of its content.
    scroll.current?.scrollResponderZoomTo({ ...rect, animated: true })
  }

  const onImagePress = (event: GestureResponderEvent) => {
    const now = Date.now()
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now
      return
    }
    lastTap.current = 0
    if (zoom.current > 1.05) {
      zoomTo({ x: 0, y: 0, width, height })
      return
    }
    // Zoom 3× around the tap: the content is the screen, with the image centred in it.
    const x = (width - fitted.w) / 2 + event.nativeEvent.locationX
    const y = (height - fitted.h) / 2 + event.nativeEvent.locationY
    zoomTo({ x: x - width / 6, y: y - height / 6, width: width / 3, height: height / 3 })
  }

  return (
    <View style={styles.backdrop} testID="chat-image-viewer">
      <ScrollView
        ref={scroll}
        maximumZoomScale={MAX_ZOOM}
        minimumZoomScale={1}
        bouncesZoom
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => { zoom.current = event.nativeEvent.zoomScale ?? 1 }}
        contentContainerStyle={{ width, height }}
      >
        <Pressable style={styles.stage} onPress={() => { if (zoom.current <= 1.05) onClose() }} accessibilityLabel="Close image" accessible={false}>
          <Pressable onPress={onImagePress} accessibilityLabel={image.name} accessibilityHint="Pinch or double-tap to zoom">
            <Image
              source={{ uri: image.uri }}
              style={{ width: fitted.w, height: fitted.h }}
              resizeMode="contain"
              onLoad={(event) => {
                const { width: w, height: h } = event.nativeEvent.source
                if (w > 0 && h > 0) setNatural({ w, h })
              }}
            />
          </Pressable>
        </Pressable>
      </ScrollView>
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close image" hitSlop={10} style={[styles.close, { top: insets.top + 8 }]}>
        <Feather name="x" size={18} color="#fff" />
      </Pressable>
      <Text numberOfLines={1} style={[styles.caption, { bottom: insets.bottom + 12 }]}>{image.name}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  // Opaque, so the chat behind neither shows through nor reaches VoiceOver.
  backdrop: { flex: 1, backgroundColor: '#000' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  close: { position: 'absolute', right: 14, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  caption: { position: 'absolute', left: 24, right: 24, textAlign: 'center', color: 'rgba(255,255,255,0.8)', fontSize: 12 },
})
