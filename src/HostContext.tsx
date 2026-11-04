import { Fragment, createContext, useCallback, useContext, useMemo, useState, type ReactNode, type SetStateAction } from 'react'
import type { RemoteHost } from '../shared/hosts'
import { createHostFetch, daemonPath, type ActiveHost } from './hostPaths'

export const ACTIVE_HOST_STORAGE_KEY = 'commando.active-host'
function storedHost(): ActiveHost {
  try { return window.localStorage.getItem(ACTIVE_HOST_STORAGE_KEY) || 'local' } catch { return 'local' }
}
const localFetch: typeof fetch = (input, init) => fetch(input, init)
const LOCAL_HOST_CONTEXT = {
  activeHost: 'local' as ActiveHost,
  local: true,
  hostName: 'This Mac',
  hosts: [] as RemoteHost[],
  setHosts: (_hosts: SetStateAction<RemoteHost[]>) => {},
  switchHost: (_host: ActiveHost) => {},
  reconnectHost: () => {},
  daemonFetch: localFetch,
  path: (path: string) => path,
  workspaceKey: 'local:0',
}
const HostContext = createContext(LOCAL_HOST_CONTEXT)

export function HostProvider({ children }: { children: ReactNode }) {
  const [activeHost, setActiveHost] = useState(storedHost)
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [controller, setController] = useState(() => new AbortController())
  const [generation, setGeneration] = useState(0)
  const switchHost = useCallback((host: ActiveHost) => {
    if (host === activeHost) return
    controller.abort()
    setController(new AbortController())
    setGeneration((current) => current + 1)
    try { window.localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, host) } catch { /* Memory selection still works. */ }
    setActiveHost(host)
  }, [activeHost, controller])
  const reconnectHost = useCallback(() => {
    controller.abort()
    setController(new AbortController())
    setGeneration((current) => current + 1)
  }, [controller])
  const daemonFetch = useMemo(() => createHostFetch(activeHost, controller.signal), [activeHost, controller])
  const path = useCallback((path: string) => daemonPath(path, activeHost), [activeHost])
  const value = useMemo(() => ({
    workspaceKey: `${activeHost}:${generation}`, activeHost, reconnectHost, local: activeHost === 'local', hosts, setHosts, switchHost,
    hostName: activeHost === 'local' ? 'This Mac' : hosts.find((host) => host.id === activeHost)?.name ?? activeHost,
    daemonFetch, path,
  }), [activeHost, generation, hosts, daemonFetch, path, switchHost, reconnectHost])
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>
}
export function useHost() {
  const host = useContext(HostContext)
  // Standalone/local consumers retain the existing fetch identity (including API caches).
  return host === LOCAL_HOST_CONTEXT ? { ...host, daemonFetch: fetch } : host
}
/** All pane/session state and API caches belong to this transport generation. */
export function HostWorkspace({ children }: { children: ReactNode }) {
  const { workspaceKey } = useHost()
  return <Fragment key={workspaceKey}>{children}</Fragment>
}
