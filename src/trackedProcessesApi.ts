import { useCallback, useEffect, useState } from 'react'
import type { TrackedProcess } from '../shared/tracked-processes'

export type StoppedProcesses = { stopped: string[]; missing: string[]; failed: number[] }

export interface TrackedProcessesApiClient {
  /** `fresh` scans now instead of reading the daemon's recent scan. */
  list(fresh?: boolean): Promise<TrackedProcess[]>
  /** With `targetId`, refuses processes that pane did not start. */
  stop(keys: string[], targetId?: string): Promise<StoppedProcesses>
}

const POLL_MS = 15_000

function apiError(status: number, body: unknown): Error {
  const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `Process request failed (${status})`
  return new Error(message)
}

export function createTrackedProcessesApi(token: string, fetcher: typeof fetch = fetch): TrackedProcessesApiClient {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`/api/tracked-processes${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
    return body as T
  }
  return {
    async list(fresh = false) {
      return (await request<{ processes: TrackedProcess[] }>(fresh ? '?fresh=1' : '')).processes
    },
    stop(keys, targetId) {
      return request<StoppedProcesses>('/stop', { method: 'POST', body: JSON.stringify({ keys, ...(targetId ? { targetId } : {}) }) })
    },
  }
}

/** Tracked processes, polled slowly while `enabled` and the page is visible; null until the first answer. */
export function useTrackedProcesses(api: TrackedProcessesApiClient | undefined, enabled: boolean) {
  const [processes, setProcesses] = useState<TrackedProcess[] | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!api) return
    try {
      setProcesses(await api.list())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to list processes')
    }
  }, [api])
  useEffect(() => {
    if (!api || !enabled) return
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, enabled, refresh])
  return { processes, error, refresh }
}
