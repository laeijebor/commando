import type { AddHostRequest, HostErrorCode, HostResponse, HostsResponse, UpdateHostRequest } from '../shared/hosts'

export function hostErrorMessage(code?: HostErrorCode): string {
  switch (code) {
    case 'invalid_host': return 'Check the name, URL and token. Use an HTTP(S) loopback or Tailscale address.'
    case 'host_unreachable': return 'Could not reach this host. Check its URL and that the daemon is running.'
    case 'host_unauthorized': return 'This host rejected the token. Replace it with its daemon token.'
    case 'unauthorized': return 'Host management requires the owner session or this Mac’s daemon token.'
    case 'host_conflict': return 'This host already exists, or changed while you were editing it. Refresh and try again.'
    default: return 'Could not update hosts. Try again.'
  }
}
export function createHostsApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async <T,>(path = '', method = 'GET', body?: object): Promise<T> => {
    const response = await fetcher(`/api/hosts${path}`, {
      method, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 204) return undefined as T
    const result = await response.json() as { code?: HostErrorCode }
    if (!response.ok) throw new Error(hostErrorMessage(result.code))
    return result as T
  }
  return {
    list: async () => {
      const result = await request<HostsResponse>()
      if (!Array.isArray(result.hosts)) throw new Error('Could not load hosts: invalid registry response')
      return result.hosts
    },
    add: async (input: AddHostRequest) => (await request<HostResponse>('', 'POST', input)).host,
    update: async (id: string, input: UpdateHostRequest) => (await request<HostResponse>(`/${encodeURIComponent(id)}`, 'PATCH', input)).host,
    remove: (id: string) => request<void>(`/${encodeURIComponent(id)}`, 'DELETE'),
  }
}
