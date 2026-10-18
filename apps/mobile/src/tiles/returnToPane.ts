import type { useRouter } from 'expo-router'

export function tileReturnTarget(hostId: string, paneId?: string) {
  return paneId
    ? { pathname: '/(host)/[hostId]/pane/[paneId]' as const, params: { hostId, paneId } }
    : { pathname: '/(host)/[hostId]/tiles' as const, params: { hostId } }
}

/** Preserve the mounted origin; an explicit target is only needed for direct entry. */
export function returnFromTile(router: Pick<ReturnType<typeof useRouter>, 'canGoBack' | 'back' | 'replace'>, hostId: string, paneId?: string): void {
  if (router.canGoBack()) router.back()
  else router.replace(tileReturnTarget(hostId, paneId))
}
