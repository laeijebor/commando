/** One-time pairing exchanges a short-lived code for a revocable device bearer. */
export type PairingCodeResponse = {
  code: string
  expiresAt: number
  urls: string[]
  name: string
  tailscaleEnabled: boolean
}
export type PairingClaimRequest = { code: string; deviceName: string; platform: 'ios' | 'android' }
export type PairingClaimResponse = { deviceId: string; token: string; name: string }
export type PairedDevice = {
  id: string
  deviceName: string
  platform: PairingClaimRequest['platform']
  createdAt: number
  lastSeenAt: number
}
export type PairingDevicesResponse = { devices: PairedDevice[] }
