import type { Host } from '../hosts/types'

export const DEMO_ORIGIN = 'http://demo:4310'
export const DEMO_HOST_ID = 'commando-demo'
export function isDemoHost(host: Pick<Host, 'baseUrl'>): boolean {
  return __DEV__ && host.baseUrl === DEMO_ORIGIN
}
export function autoDemoEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_COMMANDO_DEMO === '1'
}
export function demoHost(): Host {
  return { id: DEMO_HOST_ID, name: 'Demo studio', baseUrl: DEMO_ORIGIN, auth: { kind: 'session' } }
}
