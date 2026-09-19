import { useContext, useEffect, useState } from 'react'
import { Keyboard, Platform, type KeyboardEvent } from 'react-native'
// expo-router vendors react-navigation rather than re-exporting it, so the tab
// bar's measured height is only reachable through this path. The context is
// read directly instead of `useBottomTabBarHeight()` because that hook throws
// outside a tab navigator, and `PaneView` is also rendered by tests.
import { BottomTabBarHeightContext } from 'expo-router/build/react-navigation/bottom-tabs'

import { keyboardOverlap } from './keyboardInset'

/**
 * Padding that keeps a tab screen's bottom controls above the keyboard.
 *
 * `keyboardWillChangeFrame` is used on iOS so the inset animates with the
 * keyboard rather than snapping in after it; other platforms only get the
 * `did` events.
 */
export function useKeyboardInset(): number {
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  useEffect(() => {
    const show = (event: KeyboardEvent): void => {
      setKeyboardHeight(event.endCoordinates.height)
    }
    const hide = (): void => setKeyboardHeight(0)

    const subscriptions = Platform.OS === 'ios'
      ? [
          Keyboard.addListener('keyboardWillChangeFrame', show),
          Keyboard.addListener('keyboardWillHide', hide),
        ]
      : [
          Keyboard.addListener('keyboardDidShow', show),
          Keyboard.addListener('keyboardDidHide', hide),
        ]

    return () => {
      for (const subscription of subscriptions) subscription.remove()
    }
  }, [])

  return keyboardOverlap(keyboardHeight, tabBarHeight)
}
