import * as SecureStore from 'expo-secure-store'

/**
 * Device preferences live in SecureStore beside the host credentials. They are
 * not secret, but the app already depends on SecureStore and the values are
 * tiny, so there is no reason to pull in a second storage backend.
 */
export async function readPreference(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

export async function writePreference(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value)
  } catch {
    // A preference that cannot be persisted still applies for this launch.
  }
}

export const THEME_PREFERENCE_KEY = 'commando.theme'
export const SESSIONS_VIEW_PREFERENCE_KEY = 'commando.sessions.view'

/** Notification rules, the stable per-install push device id and the hosts it is registered with. */
export const PUSH_RULES_PREFERENCE_KEY = 'commando.push.rules'
export const PUSH_DEVICE_ID_KEY = 'commando.push.deviceId'
export const PUSH_REGISTERED_HOSTS_KEY = 'commando.push.hosts'
