const TOKEN_STORAGE_KEY = 'commando.session-token'

export function getInitialToken(): string {
  const hash = window.location.hash.slice(1)
  const hashParams = new URLSearchParams(hash)
  let token = hashParams.get('token') ?? ''

  if (!token && hash && !hash.includes('=')) {
    try {
      token = decodeURIComponent(hash)
    } catch {
      token = hash
    }
  }

  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      return token
    }
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return token
  }
}

export function storeToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // A private browser session may block storage; the in-memory token still works.
  }
}

export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // The in-memory credential can still be cleared when storage is unavailable.
  }
}
