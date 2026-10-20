import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/** Screen focus is supplied by the route/cockpit; AppState also pauses background work. */
export function useAppActive(focused = true): boolean {
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  return focused && active
}
