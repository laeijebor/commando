import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native'

import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { toViewRect, type TileGeometry, type TilePoint } from './input'
import type { TileInspectRect } from './protocol'
import type { TileRelayState } from './relay'

const TAP_SLOP = 10
const LONG_PRESS_MS = 500

export type TilePin = {
  noteId: number
  rect: TileInspectRect
  kind: 'annotation' | 'response'
  selected: boolean
}

/**
 * The screencast itself: the newest PNG frame, the gestures that turn into
 * CDP input, and the review overlay drawn on top of it.
 *
 * Frames are double-buffered. Swapping one `<Image>`'s source blanks it while
 * the next PNG decodes, which at screencast rates reads as a flicker; two
 * layers with the incoming frame drawn behind and promoted on `onLoad` keep a
 * painted frame on screen at all times.
 */
export function TileSurface({
  state,
  geometry,
  reviewMode,
  highlight,
  pins,
  onLayoutSize,
  onTap,
  onLongPress,
  onPan,
  onPinPress,
  children,
}: {
  state: TileRelayState
  geometry: TileGeometry
  reviewMode: boolean
  highlight: TileInspectRect | null
  pins: readonly TilePin[]
  onLayoutSize: (size: { width: number; height: number }) => void
  onTap: (point: TilePoint) => void
  onLongPress: (point: TilePoint) => void
  onPan: (point: TilePoint, movement: TilePoint) => void
  onPinPress: (noteId: number) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const [layers, setLayers] = useState<{ front: string | null; back: string | null }>({
    front: null,
    back: null,
  })
  const shownSeq = useRef(0)

  useEffect(() => {
    if (!state.frame || state.frameSeq === shownSeq.current) return
    shownSeq.current = state.frameSeq
    setLayers((current) => ({ ...current, back: `data:image/png;base64,${state.frame ?? ''}` }))
  }, [state.frame, state.frameSeq])

  const gesture = useRef({
    startedAt: 0,
    lastDx: 0,
    lastDy: 0,
    panning: false,
    abandoned: false,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent
          const current = gesture.current
          current.startedAt = Date.now()
          current.lastDx = 0
          current.lastDy = 0
          current.panning = false
          current.abandoned = false
          if (current.timer) clearTimeout(current.timer)
          current.timer = setTimeout(() => {
            current.timer = null
            if (current.panning || current.abandoned) return
            current.abandoned = true
            onLongPress({ x: locationX, y: locationY })
          }, LONG_PRESS_MS)
        },
        onPanResponderMove: (event, gestureState) => {
          const current = gesture.current
          // Pinch is not mapped: CDP has no pinch, and the page already lays
          // out for the phone's viewport, so a two-finger gesture is dropped
          // rather than sent as a stray scroll.
          if (event.nativeEvent.touches.length > 1) {
            current.abandoned = true
            if (current.timer) {
              clearTimeout(current.timer)
              current.timer = null
            }
            return
          }
          if (current.abandoned) return
          const travelled = Math.hypot(gestureState.dx, gestureState.dy)
          if (!current.panning && travelled < TAP_SLOP) return
          if (!current.panning) {
            current.panning = true
            if (current.timer) {
              clearTimeout(current.timer)
              current.timer = null
            }
          }
          const movement = {
            x: gestureState.dx - current.lastDx,
            y: gestureState.dy - current.lastDy,
          }
          current.lastDx = gestureState.dx
          current.lastDy = gestureState.dy
          if (movement.x === 0 && movement.y === 0) return
          onPan({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, movement)
        },
        onPanResponderRelease: (event) => {
          const current = gesture.current
          if (current.timer) {
            clearTimeout(current.timer)
            current.timer = null
          }
          if (current.panning || current.abandoned) return
          if (Date.now() - current.startedAt >= LONG_PRESS_MS) return
          onTap({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY })
        },
        onPanResponderTerminate: () => {
          const current = gesture.current
          if (current.timer) clearTimeout(current.timer)
          current.timer = null
          current.abandoned = true
        },
      }),
    [onLongPress, onPan, onTap],
  )

  useEffect(() => () => {
    if (gesture.current.timer) clearTimeout(gesture.current.timer)
  }, [])

  const handleLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout
    if (width > 0 && height > 0) onLayoutSize({ width, height })
  }

  const painting = state.phase === 'connecting' || (state.phase === 'ready' && !layers.front)

  return (
    <View
      onLayout={handleLayout}
      style={[styles.surface, { backgroundColor: theme.surfaceDeep, borderColor: theme.border }]}
      {...panResponder.panHandlers}
    >
      {layers.front ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="stretch"
          source={{ uri: layers.front }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {layers.back && layers.back !== layers.front ? (
        <Image
          accessibilityIgnoresInvertColors
          // Promote the decoded frame only once it can actually be painted.
          onLoad={() => setLayers((current) => ({ front: current.back, back: current.back }))}
          resizeMode="stretch"
          source={{ uri: layers.back }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      {painting ? (
        <View style={styles.centre}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.centreText, { color: theme.muted }]}>
            {state.detail || 'Waiting for the first frame…'}
          </Text>
        </View>
      ) : null}

      {reviewMode && highlight ? (
        <View
          pointerEvents="none"
          style={[
            styles.highlight,
            toViewRect(highlight, geometry),
            { borderColor: theme.amber, backgroundColor: withAlpha(theme.amber, 0.12) },
          ]}
        />
      ) : null}

      {reviewMode
        ? pins.map((pin) => {
            const rect = toViewRect(pin.rect, geometry)
            return (
              <Pressable
                accessibilityLabel={`Queued ${pin.kind} ${pin.noteId}`}
                accessibilityRole="button"
                key={pin.noteId}
                onPress={() => onPinPress(pin.noteId)}
                style={[
                  styles.pin,
                  {
                    left: Math.max(0, rect.x - 6),
                    top: Math.max(0, rect.y - 10),
                    backgroundColor: pin.kind === 'response' ? theme.green : theme.amber,
                    borderColor: pin.selected ? theme.text : 'transparent',
                  },
                ]}
              >
                <Text style={styles.pinLabel}>{pin.noteId}</Text>
              </Pressable>
            )
          })
        : null}

      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  surface: { flex: 1, borderWidth: 1, borderRadius: 14, overflow: 'hidden', position: 'relative' },
  centre: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  },
  centreText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  highlight: { position: 'absolute', borderWidth: 2, borderRadius: 4 },
  pin: {
    position: 'absolute',
    minWidth: 22,
    height: 22,
    paddingHorizontal: 5,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinLabel: { fontSize: 11, fontWeight: '800', color: '#1c1406' },
})
