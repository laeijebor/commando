import { useEffect, useState } from 'react'
import { Animated, AccessibilityInfo, StyleSheet, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import { useTheme } from '../theme'
import type { Attention } from './chatListModel'

export function WorkingPulse(): React.JSX.Element {
  const theme = useTheme()
  const [opacity] = useState(() => new Animated.Value(1))
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined
    let disposed = false
    const update = (reduce: boolean) => {
      if (disposed) return
      animation?.stop()
      opacity.setValue(1)
      if (!reduce && !disposed) {
        animation = Animated.loop(Animated.sequence([Animated.timing(opacity, { toValue: 0.3, duration: 900, useNativeDriver: true, isInteraction: false }), Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true, isInteraction: false })]))
        animation.start()
      }
    }
    void AccessibilityInfo.isReduceMotionEnabled().then(update)
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', update)
    return () => { disposed = true; animation?.stop(); subscription.remove() }
  }, [opacity])
  return <Animated.View style={[styles.dot, { backgroundColor: theme.accent, opacity }]} />
}
export function ChatIndicator({ attention }: { attention: Attention }): React.JSX.Element {
  const theme = useTheme()
  if (attention === 'working') return <WorkingPulse />
  if (attention === 'finished') return <Feather name="check" size={12} color={theme.green} />
  const color = attention === 'needs_input' ? theme.amber : attention === 'failed' ? theme.red : attention === 'review' ? theme.green : theme.muted
  return <View style={[styles.dot, { borderColor: color, backgroundColor: attention === 'idle' ? 'transparent' : color, borderWidth: attention === 'idle' ? 1.5 : 0, borderRadius: attention === 'needs_input' || attention === 'failed' ? 1 : 4, transform: [{ rotate: attention === 'needs_input' ? '45deg' : '0deg' }] }]} />
}
const styles = StyleSheet.create({
  dot: { width: 7, height: 7, borderRadius: 4 },
})
