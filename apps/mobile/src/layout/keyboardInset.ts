/**
 * How far a screen inside the tab bar has to lift to clear the keyboard.
 *
 * `KeyboardAvoidingView` cannot work this out on these screens: it measures
 * itself with `onLayout`, whose frame is relative to its *parent*, then
 * compares that against the keyboard's position on *screen*. Inside a tab
 * navigator, with a header and a status row above it, the two coordinate
 * spaces differ by enough that the composer ends up under the keyboard.
 *
 * The real geometry is simple. The keyboard covers `keyboardHeight` measured
 * up from the bottom of the window, and the tab bar already occupies
 * `tabBarHeight` of exactly that strip — the keyboard draws straight over it.
 * So a screen whose content stops at the tab bar only has to clear whatever is
 * left.
 */
export function keyboardOverlap(keyboardHeight: number, tabBarHeight: number): number {
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0
  const tabBar = Number.isFinite(tabBarHeight) && tabBarHeight > 0 ? tabBarHeight : 0
  return Math.max(0, keyboardHeight - tabBar)
}
