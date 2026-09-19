import type { Host } from '../hosts/types'
import {
  DEFAULT_PUSH_RULES,
  deviceRegistrationBody,
  MAX_MUTED_SESSIONS,
  normalisePushRules,
  parsePushRules,
  toggleMutedSession,
  withQuietHours,
  type PushRules,
} from './rules'
import { usePushStore } from './store'

const HOST: Host = {
  id: 'host-1',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret' },
}

const RULES: PushRules = {
  needsInput: true,
  done: false,
  failed: true,
  quietHours: { start: '23:00', end: '07:00', timeZone: 'Europe/Berlin' },
  mutedSessions: ['scratch', 'dotfiles'],
}

describe('notification rules', () => {
  it('turns the settings rows into the daemon registration body', () => {
    expect(deviceRegistrationBody({
      id: 'ios-abc',
      expoPushToken: 'ExponentPushToken[xxx]',
      name: "  Leo's iPhone  ",
      rules: RULES,
    })).toEqual({
      id: 'ios-abc',
      expoPushToken: 'ExponentPushToken[xxx]',
      name: "Leo's iPhone",
      platform: 'ios',
      rules: {
        needsInput: true,
        done: false,
        failed: true,
        quietHours: { start: '23:00', end: '07:00', timeZone: 'Europe/Berlin' },
        mutedSessions: ['scratch', 'dotfiles'],
      },
    })
  })

  it('drops quiet hours the daemon would reject rather than being refused', () => {
    const body = deviceRegistrationBody({
      id: 'ios-abc',
      expoPushToken: 'ExponentPushToken[xxx]',
      name: 'iPhone',
      rules: { ...RULES, quietHours: { start: '25:00', end: '07:00', timeZone: 'Europe/Berlin' } },
    })
    expect(body.rules.quietHours).toBeUndefined()
  })

  it('caps and de-duplicates muted sessions', () => {
    const many = Array.from({ length: MAX_MUTED_SESSIONS + 5 }, (_, index) => `s${index}`)
    const rules = normalisePushRules({ ...DEFAULT_PUSH_RULES, mutedSessions: [...many, 's0', '  '] })
    expect(rules.mutedSessions).toHaveLength(MAX_MUTED_SESSIONS)
  })

  it('toggles a session in and out of the mute list', () => {
    const muted = toggleMutedSession(DEFAULT_PUSH_RULES, 'scratch')
    expect(muted.mutedSessions).toEqual(['scratch'])
    expect(toggleMutedSession(muted, 'scratch').mutedSessions).toEqual([])
  })

  it('clears quiet hours without leaving the key behind', () => {
    expect(withQuietHours(RULES, null)).not.toHaveProperty('quietHours')
  })

  it('round-trips through the persisted preference and tolerates rubbish', () => {
    expect(parsePushRules(JSON.stringify(RULES))).toEqual(RULES)
    expect(parsePushRules('not json')).toEqual(DEFAULT_PUSH_RULES)
    expect(parsePushRules(null)).toEqual(DEFAULT_PUSH_RULES)
  })
})

describe('registering the device with a host', () => {
  beforeEach(() => {
    ;(globalThis.fetch as jest.Mock).mockClear()
    usePushStore.setState({
      hydrated: true,
      deviceId: 'ios-abc',
      deviceName: "Leo's iPhone",
      permission: 'granted',
      token: { kind: 'token', value: 'ExponentPushToken[xxx]' },
      rules: RULES,
      registrations: {},
    })
  })

  it('PUTs the registration body to /api/push/devices/:id', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const registration = await usePushStore.getState().registerHost(HOST)

    expect(registration.ok).toBe(true)
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HOST.baseUrl}/api/push/devices/ios-abc`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      id: 'ios-abc',
      expoPushToken: 'ExponentPushToken[xxx]',
      name: "Leo's iPhone",
      platform: 'ios',
      rules: RULES,
    })
    expect(usePushStore.getState().registeredHostIds()).toEqual(['host-1'])
  })

  it("keeps the daemon complaint on the registration instead of throwing", async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'expoPushToken must look like ExponentPushToken[...]' }), { status: 400 }),
    )

    const registration = await usePushStore.getState().registerHost(HOST)

    expect(registration).toMatchObject({
      ok: false,
      error: 'expoPushToken must look like ExponentPushToken[...]',
    })
    expect(usePushStore.getState().registeredHostIds()).toEqual([])
  })

  it('does not register without a token', async () => {
    usePushStore.setState({ token: { kind: 'none' } })
    const registration = await usePushStore.getState().registerHost(HOST)
    expect(registration).toMatchObject({ ok: false, error: 'No Expo push token on this install' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('posts the test route for the same device id', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, accepted: 1, rejected: 0 }), { status: 202 }),
    )

    const result = await usePushStore.getState().sendTest(HOST)

    expect(result.ok).toBe(true)
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HOST.baseUrl}/api/push/devices/ios-abc/test`)
    expect(init.method).toBe('POST')
  })
})
