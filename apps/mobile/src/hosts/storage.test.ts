import * as SecureStore from 'expo-secure-store'

import { HOSTS_STORAGE_KEY, loadHosts, saveHosts } from './storage'
import { useHostsStore } from './store'
import type { Host } from './types'
import { normaliseBaseUrl, webSocketBase } from './types'

const STUDIO: Host = {
  id: 'host-studio',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'session' },
}

const MBA: Host = {
  id: 'host-mba',
  name: 'mba',
  baseUrl: 'http://100.101.2.7:4310',
  auth: { kind: 'token', token: 'commando-automation-token' },
}

beforeEach(async () => {
  await SecureStore.deleteItemAsync(HOSTS_STORAGE_KEY)
  jest.clearAllMocks()
  useHostsStore.setState({ hosts: [], hydrated: false, reachability: {}, cookies: {} })
})

describe('host persistence', () => {
  it('round-trips the list, tokens included, through SecureStore', async () => {
    await saveHosts([STUDIO, MBA])
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      HOSTS_STORAGE_KEY,
      JSON.stringify([STUDIO, MBA]),
    )
    await expect(loadHosts()).resolves.toEqual([STUDIO, MBA])
  })

  it('returns an empty list when nothing has been stored', async () => {
    await expect(loadHosts()).resolves.toEqual([])
  })

  it('drops entries that no longer match the host shape', async () => {
    await SecureStore.setItemAsync(
      HOSTS_STORAGE_KEY,
      JSON.stringify([STUDIO, { id: 'broken' }, { ...MBA, auth: { kind: 'token' } }]),
    )
    await expect(loadHosts()).resolves.toEqual([STUDIO])
  })

  it('survives a corrupt keychain value', async () => {
    await SecureStore.setItemAsync(HOSTS_STORAGE_KEY, 'not json at all')
    await expect(loadHosts()).resolves.toEqual([])
  })

  it('never lets a failed write throw into the UI', async () => {
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(saveHosts([STUDIO])).resolves.toBeUndefined()
  })
})

describe('the hosts store', () => {
  it('adds a host, normalises its address and persists it', async () => {
    const host = await useHostsStore.getState().addHost({
      name: 'studio',
      baseUrl: 'studio.tail-1a2b.ts.net:4310',
    })
    expect(host.baseUrl).toBe('http://studio.tail-1a2b.ts.net:4310')
    expect(useHostsStore.getState().hosts).toHaveLength(1)
    await expect(loadHosts()).resolves.toHaveLength(1)
  })

  it('swaps a host to token auth and forgets its cookie on removal', async () => {
    const host = await useHostsStore.getState().addHost({ name: 'mba', baseUrl: '100.101.2.7:4310' })
    useHostsStore.getState().setCookie(host.id, 'commando.session=abc; Path=/')
    await useHostsStore.getState().updateHost(host.id, { auth: { kind: 'token', token: 'tkn' } })
    expect(useHostsStore.getState().hosts[0]?.auth).toEqual({ kind: 'token', token: 'tkn' })

    await useHostsStore.getState().removeHost(host.id)
    expect(useHostsStore.getState().hosts).toEqual([])
    expect(useHostsStore.getState().cookies[host.id]).toBeUndefined()
    await expect(loadHosts()).resolves.toEqual([])
  })

  it('hydrates from the keychain', async () => {
    await saveHosts([STUDIO])
    await useHostsStore.getState().hydrate()
    expect(useHostsStore.getState().hosts).toEqual([STUDIO])
    expect(useHostsStore.getState().hydrated).toBe(true)
  })
})

describe('address handling', () => {
  it('defaults to http and the daemon port', () => {
    expect(normaliseBaseUrl('studio.tail-1a2b.ts.net')).toBe('http://studio.tail-1a2b.ts.net:4310')
    expect(normaliseBaseUrl(' https://studio.example.com ')).toBe('https://studio.example.com:443')
    expect(normaliseBaseUrl('100.101.2.7:4310')).toBe('http://100.101.2.7:4310')
  })

  it('rejects addresses the daemon cannot serve', () => {
    expect(() => normaliseBaseUrl('')).toThrow('Enter the daemon address')
    expect(() => normaliseBaseUrl('ftp://studio:21')).toThrow('http or https')
  })

  it('maps the http origin onto the websocket origin', () => {
    expect(webSocketBase('http://studio:4310')).toBe('ws://studio:4310')
    expect(webSocketBase('https://studio:443')).toBe('wss://studio:443')
  })
})
