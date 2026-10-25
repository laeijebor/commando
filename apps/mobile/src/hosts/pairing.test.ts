import * as SecureStore from 'expo-secure-store'
import { useHostsStore } from './store'
import { HOSTS_STORAGE_KEY, loadHosts } from './storage'
import type { Host } from './types'
import { useSessionPreferences } from '../ui/sessionPreferences'
import { disconnectHost } from '../daemon/client'

jest.mock('../daemon/client', () => ({ disconnectHost: jest.fn() }))
jest.mock('./api', () => ({ probeHost: jest.fn(async () => ({ state: 'online' })) }))

const dns = 'http://studio.tail.ts.net:4310'
const ip = 'http://100.64.0.1:4310'
const pairing = { name: 'Studio Mac', urls: [dns, ip] }
const existing: Host = { id: 'keep-this-id', name: 'My workstation', baseUrl: dns, auth: { kind: 'token', token: 'old-token' } }
const input = { name: 'Studio Mac', baseUrl: ip, token: 'replacement-token', pairing }
beforeEach(async () => {
  jest.clearAllMocks()
  await SecureStore.deleteItemAsync(HOSTS_STORAGE_KEY)
  useHostsStore.setState({ hosts: [existing], hydrated: true, selectedHostId: existing.id, reachability: {}, cookies: { [existing.id]: 'old-cookie' } })
  useSessionPreferences.setState({ seen: { [existing.id]: { '%1': 123 } } })
})
it('replaces a host matched by any advertised URL, preserving id, name, selection and per-host preferences', async () => {
  const host = await useHostsStore.getState().savePairedHost(input)
  expect(host).toMatchObject({ ...existing, baseUrl: ip, auth: { kind: 'token', token: input.token }, pairing })
  expect(useHostsStore.getState().hosts).toEqual([host])
  expect(useHostsStore.getState().selectedHostId).toBe(existing.id)
  expect(useSessionPreferences.getState().seen[existing.id]).toEqual({ '%1': 123 })
  expect(useHostsStore.getState().cookies[existing.id]).toBeUndefined()
  expect(disconnectHost).toHaveBeenCalledWith(existing.id)
  expect(await loadHosts()).toEqual([host])
})
it('matches saved pairing name and URLs when the previously chosen IP has changed', async () => {
  useHostsStore.setState({ hosts: [{ ...existing, baseUrl: 'http://100.64.0.9:4310', pairing: { name: pairing.name, urls: [dns, 'http://100.64.0.9:4310'] } }] })
  expect((await useHostsStore.getState().savePairedHost(input)).id).toBe(existing.id)
  expect(useHostsStore.getState().hosts).toHaveLength(1)
})
it('repeated claims update the same saved row', async () => {
  for (const token of ['new-1', 'new-2', 'new-3']) {
    expect((await useHostsStore.getState().savePairedHost({ ...input, token })).id).toBe(existing.id)
  }
  expect(useHostsStore.getState().hosts).toHaveLength(1)
  expect((await loadHosts())[0]?.auth).toEqual({ kind: 'token', token: 'new-3' })
})
it('does not merge machines just because their pairing names agree', async () => {
  useHostsStore.setState({ hosts: [{ ...existing, baseUrl: 'http://other:4310', pairing: { name: pairing.name, urls: ['http://other:4310'] } }] })
  const created = await useHostsStore.getState().savePairedHost(input)
  expect(created.id).not.toBe(existing.id)
  expect(useHostsStore.getState().hosts).toHaveLength(2)
  expect(useHostsStore.getState().selectedHostId).toBe(existing.id)
})
it('leaves replacement credentials and selection untouched when secure persistence fails', async () => {
  ;(SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('Keychain unavailable'))
  await expect(useHostsStore.getState().savePairedHost(input)).rejects.toThrow('Could not save')
  expect(useHostsStore.getState().hosts).toEqual([existing])
  expect(useHostsStore.getState().selectedHostId).toBe(existing.id)
  expect(disconnectHost).not.toHaveBeenCalled()
})
