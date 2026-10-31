/** Public host records never contain a credential. Times are Unix milliseconds. */
export type HostHealth = {
  state: 'online' | 'offline' | 'unauthorized' | 'unknown'
  checkedAt: number | null
  latencyMs?: number
  version?: string
}

export type RemoteHost = {
  id: string
  name: string
  baseUrl: string
  addedAt: number
  health: HostHealth
}

export type HostsResponse = { hosts: RemoteHost[] }
export type HostResponse = { host: RemoteHost }
export type AddHostRequest = { name: string; baseUrl: string; token: string }
export type UpdateHostRequest = { name?: string; token?: string }
export type HostErrorCode =
  | 'unauthorized' | 'not_found' | 'method_not_allowed'
  | 'invalid_host' | 'invalid_json' | 'unsupported_media_type' | 'body_too_large'
  | 'hosts_corrupt' | 'hosts_storage_error' | 'host_conflict'
  | 'host_unreachable' | 'host_unauthorized'
export type HostErrorResponse = { error: string; code: HostErrorCode }
