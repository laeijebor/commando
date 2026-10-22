import { useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'

/**
 * expo-router 57 runs every route param through `decodeURIComponent` even
 * when it was never encoded, which garbles tmux ids: pane `%139` comes back
 * as a control character followed by `9`. Ids therefore travel through routes
 * with `%` swapped for `~` (which tmux ids never contain and URLs leave alone),
 * and are swapped back when a screen reads them.
 */
export function routeParams<T extends Record<string, string | undefined>>(params: T): T {
  return mapValues(params, (value) => value.replaceAll('%', '~'))
}

/** `useLocalSearchParams`, with the ids `routeParams` swapped restored. */
export function useRouteParams<T extends Record<string, string | undefined>>(): T {
  const raw = useLocalSearchParams()
  return useMemo(() => readRouteParams<T>(raw), [raw])
}

export function readRouteParams<T extends Record<string, string | undefined>>(raw: Record<string, string | string[] | undefined>): T {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string') params[key] = first.replaceAll('~', '%')
  }
  return params as T
}

function mapValues<T extends Record<string, string | undefined>>(params: T, map: (value: string) => string): T {
  const next: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(params)) next[key] = value === undefined ? undefined : map(value)
  return next as T
}
