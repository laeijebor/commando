export type ActiveHost = 'local' | string
export const LOCAL_ONLY_NOTE = 'Only on this Mac for now'

/** These resources have companion routes outside the proxy's /api and /ws contract. */
export function isLocalOnlyPath(path: string): boolean {
  return /^\/(?:api\/(?:hosts|auth|pairing|sims|ides|web-panes|redline|screenshots)(?:\/|$)|ide(?:\/|$)|redline(?:\/|$)|screenshots(?:\/|$)|chat-images(?:\/|$)|ws\/(?:web-tiles|api\/sims)(?:\/|$))/.test(path.split(/[?#]/)[0])
    || /^\/api\/pane-management\/panes\/[^/]+\/(?:open|reveal)$/.test(path.split(/[?#]/)[0])
}

/** The only daemon path mapper. Local URLs are returned byte-for-byte unchanged. */
export function daemonPath(path: string, host: ActiveHost): string {
  if (host === 'local' || isLocalOnlyPath(path)) return path
  if (path.startsWith('/api/') || /^\/ws(?:[?#]|$)/.test(path)) return `/h/${encodeURIComponent(host)}${path}`
  return path
}

/** Bind requests to one workspace; a retired workspace can never send new mutations. */
export function createHostFetch(host: ActiveHost, signal?: AbortSignal, fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    if (signal?.aborted) return Promise.reject(new DOMException('Host changed', 'AbortError'))
    if (typeof input !== 'string') return Promise.reject(new Error('Expected a daemon path'))
    if (host !== 'local' && (isLocalOnlyPath(input) || daemonPath(input, host) === input)) return Promise.reject(new Error(LOCAL_ONLY_NOTE))
    return fetcher(daemonPath(input, host), {
      ...init,
      ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}),
    })
  }
}

export function daemonWebSocketUrl(host: ActiveHost, token: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${daemonPath('/ws', host)}${token ? `?token=${encodeURIComponent(token)}` : ''}`
}
