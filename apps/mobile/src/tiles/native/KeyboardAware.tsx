import { useCallback, useRef, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

/**
 * A KeyboardAvoidingView that knows where it sits. React Native compares the
 * keyboard's top (in window coordinates) with the view's layout frame, which
 * is relative to its parent; nested under a header that under-shoots by the
 * parent's own distance from the top of the window. The difference between
 * the window position and the layout position is exactly that distance.
 */
export function KeyboardAware({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }): React.JSX.Element {
  const probe = useRef<View>(null)
  const [offset, setOffset] = useState(0)
  const measure = useCallback((event: LayoutChangeEvent) => {
    const layoutY = event.nativeEvent.layout.y
    probe.current?.measureInWindow((_x, windowY) => {
      if (Number.isFinite(windowY)) setOffset(Math.max(0, windowY - layoutY))
    })
  }, [])
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={offset}
      onLayout={measure}
      style={style}
    >
      <View collapsable={false} pointerEvents="none" ref={probe} />
      {children}
    </KeyboardAvoidingView>
  )
}
