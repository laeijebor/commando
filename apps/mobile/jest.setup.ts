// SecureStore is a native module; tests drive it through this in-memory double
// and assert on what the app asked it to persist.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>()
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key)
    }),
  }
})

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

// Push needs native modules: the unit suite drives these doubles instead, and
// asserts on the categories and registrations the app asked for.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(async () => ({ identifier: 'stub', actions: [] })),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[unit-test]', type: 'expo' })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}))

jest.mock('expo-device', () => ({
  isDevice: true,
  deviceName: "Leo's iPhone",
  modelName: 'iPhone 15 Pro',
}))

// Nothing in the unit suite should reach the network; the reachability probe
// is exercised through this stub rather than a real daemon.
globalThis.fetch = jest.fn(async () => new Response(
  JSON.stringify({ ok: true, sessions: 0 }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)) as unknown as typeof fetch
