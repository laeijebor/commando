import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { create } from 'zustand'

import { daemonFetch } from '../hosts/api'
import type { Host } from '../hosts/types'
import {
  PUSH_DEVICE_ID_KEY,
  PUSH_REGISTERED_HOSTS_KEY,
  PUSH_RULES_PREFERENCE_KEY,
  readPreference,
  writePreference,
} from '../prefs'
import { registerNotificationCategories } from './categories'
import {
  DEFAULT_PUSH_RULES,
  deviceRegistrationBody,
  parsePushRules,
  serialisePushRules,
  type PushRules,
} from './rules'

export type PushPermission = 'unknown' | 'granted' | 'denied' | 'undetermined'

export type PushTokenState =
  | { kind: 'none' }
  | { kind: 'token'; value: string }
  /** A simulator, a missing EAS project id, or a token request that failed. */
  | { kind: 'unavailable'; reason: string }

export type HostRegistration = {
  hostId: string
  ok: boolean
  at: number
  error?: string
}

type PushStoreState = {
  hydrated: boolean
  deviceId: string | null
  deviceName: string
  permission: PushPermission
  token: PushTokenState
  rules: PushRules
  registrations: Record<string, HostRegistration>
  hydrate: () => Promise<void>
  refreshPermission: () => Promise<PushPermission>
  /** Asks for permission, fetches the Expo token and registers the categories. */
  enable: () => Promise<PushTokenState>
  setRules: (rules: PushRules, hosts: readonly Host[]) => Promise<void>
  registerHost: (host: Host) => Promise<HostRegistration>
  registerAll: (hosts: readonly Host[]) => Promise<void>
  sendTest: (host: Host) => Promise<{ ok: boolean; message: string }>
  registeredHostIds: () => string[]
  /** Drops a removed host's registration so notifications never resolve to it. */
  forgetHost: (hostId: string) => Promise<void>
}

function createDeviceId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `ios-${Date.now().toString(36)}-${random}`.slice(0, 64)
}

function easProjectId(): string | undefined {
  const config = Constants.expoConfig as { extra?: { eas?: { projectId?: string } } } | null
  const fromExtra = config?.extra?.eas?.projectId
  const fromEas = (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
  return fromExtra ?? fromEas
}

function deviceName(): string {
  return Device.deviceName?.trim() || `${Device.modelName ?? 'iPhone'}`
}

async function readRegisteredHostIds(): Promise<string[]> {
  const raw = await readPreference(PUSH_REGISTERED_HOSTS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Push registration state for this install: one device id shared by every
 * host, the rules the user set, and what each daemon answered. The host id is
 * kept beside each registration because the daemon's notification payload does
 * not carry one.
 */
export const usePushStore = create<PushStoreState>((set, get) => ({
  hydrated: false,
  deviceId: null,
  deviceName: 'iPhone',
  permission: 'unknown',
  token: { kind: 'none' },
  rules: DEFAULT_PUSH_RULES,
  registrations: {},

  hydrate: async () => {
    const [storedId, storedRules, storedHosts] = await Promise.all([
      readPreference(PUSH_DEVICE_ID_KEY),
      readPreference(PUSH_RULES_PREFERENCE_KEY),
      readRegisteredHostIds(),
    ])
    const deviceId = storedId ?? createDeviceId()
    if (!storedId) await writePreference(PUSH_DEVICE_ID_KEY, deviceId)
    const registrations: Record<string, HostRegistration> = {}
    for (const hostId of storedHosts) {
      registrations[hostId] = { hostId, ok: true, at: 0 }
    }
    set({
      hydrated: true,
      deviceId,
      deviceName: deviceName(),
      rules: parsePushRules(storedRules),
      registrations,
    })
    await get().refreshPermission()
  },

  refreshPermission: async () => {
    let permission: PushPermission = 'unknown'
    try {
      const status = await Notifications.getPermissionsAsync()
      permission = status.granted
        ? 'granted'
        : status.canAskAgain ? 'undetermined' : 'denied'
    } catch {
      permission = 'unknown'
    }
    set({ permission })
    return permission
  },

  enable: async () => {
    if (!Device.isDevice) {
      const token: PushTokenState = {
        kind: 'unavailable',
        reason: 'Push tokens need a real device; the simulator cannot have one.',
      }
      set({ token })
      return token
    }

    let granted = false
    try {
      const current = await Notifications.getPermissionsAsync()
      granted = current.granted
      if (!granted && current.canAskAgain) {
        const asked = await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true },
        })
        granted = asked.granted
      }
    } catch (error) {
      const token: PushTokenState = {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'Could not read the notification permission',
      }
      set({ token, permission: 'unknown' })
      return token
    }

    if (!granted) {
      set({ permission: 'denied', token: { kind: 'none' } })
      return { kind: 'none' as const }
    }
    set({ permission: 'granted' })

    await registerNotificationCategories()

    const projectId = easProjectId()
    try {
      const token = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      )
      const next: PushTokenState = { kind: 'token', value: token.data }
      set({ token: next, deviceName: deviceName() })
      return next
    } catch (error) {
      const next: PushTokenState = {
        kind: 'unavailable',
        reason: error instanceof Error
          ? error.message
          : 'Could not fetch an Expo push token for this build',
      }
      set({ token: next })
      return next
    }
  },

  setRules: async (rules, hosts) => {
    set({ rules })
    await writePreference(PUSH_RULES_PREFERENCE_KEY, serialisePushRules(rules))
    await get().registerAll(hosts)
  },

  registerHost: async (host) => {
    const { deviceId, token, rules } = get()
    const fail = (error: string): HostRegistration => {
      const registration: HostRegistration = { hostId: host.id, ok: false, at: Date.now(), error }
      set({ registrations: { ...get().registrations, [host.id]: registration } })
      return registration
    }
    if (!deviceId) return fail('The device id has not been created yet')
    if (token.kind !== 'token') return fail('No Expo push token on this install')

    const body = deviceRegistrationBody({
      id: deviceId,
      expoPushToken: token.value,
      name: get().deviceName,
      platform: 'ios',
      rules,
    })
    try {
      const response = await daemonFetch(host, `/api/push/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        return fail(payload.error ?? `The daemon answered ${response.status}`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'The daemon is unreachable')
    }

    const registration: HostRegistration = { hostId: host.id, ok: true, at: Date.now() }
    const registrations = { ...get().registrations, [host.id]: registration }
    set({ registrations })
    await writePreference(
      PUSH_REGISTERED_HOSTS_KEY,
      JSON.stringify(Object.values(registrations).filter((entry) => entry.ok).map((entry) => entry.hostId)),
    )
    return registration
  },

  registerAll: async (hosts) => {
    if (get().token.kind !== 'token') return
    for (const host of hosts) await get().registerHost(host)
  },

  sendTest: async (host) => {
    const deviceId = get().deviceId
    if (!deviceId) return { ok: false, message: 'This install has no device id yet' }
    if (get().token.kind !== 'token') return { ok: false, message: 'Register a push token first' }
    try {
      const response = await daemonFetch(
        host,
        `/api/push/devices/${encodeURIComponent(deviceId)}/test`,
        { method: 'POST', body: {} },
      )
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean
        accepted?: number
        error?: string
      }
      if (!response.ok) {
        return { ok: false, message: payload.error ?? `The daemon answered ${response.status}` }
      }
      return payload.ok
        ? { ok: true, message: `Expo accepted ${payload.accepted ?? 1} message(s)` }
        : { ok: false, message: 'Expo rejected the test notification' }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The daemon is unreachable',
      }
    }
  },

  forgetHost: async (hostId) => {
    if (!(hostId in get().registrations)) return
    const registrations = { ...get().registrations }
    delete registrations[hostId]
    set({ registrations })
    await writePreference(
      PUSH_REGISTERED_HOSTS_KEY,
      JSON.stringify(Object.values(registrations).filter((entry) => entry.ok).map((entry) => entry.hostId)),
    )
  },

  registeredHostIds: () => Object.values(get().registrations)
    .filter((registration) => registration.ok)
    .sort((left, right) => right.at - left.at)
    .map((registration) => registration.hostId),
}))

/** One line for the settings screen: what state registration is actually in. */
export function registrationSummary(state: {
  permission: PushPermission
  token: PushTokenState
  registrations: Record<string, HostRegistration>
}): string {
  if (state.permission === 'denied') return 'Notifications are turned off in iOS Settings'
  if (state.token.kind === 'unavailable') return state.token.reason
  if (state.token.kind === 'none') {
    return state.permission === 'granted' ? 'Allowed, but not registered yet' : 'Not registered'
  }
  const registrations = Object.values(state.registrations)
  const ok = registrations.filter((registration) => registration.ok)
  if (ok.length === 0) {
    const failed = registrations.find((registration) => registration.error)
    return failed ? `Token ready · ${failed.error}` : 'Token ready · no host registered yet'
  }
  return `Registered with ${ok.length} host${ok.length === 1 ? '' : 's'}`
}
