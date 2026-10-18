export function tileReturnTarget(hostId: string, paneId?: string) {
  return paneId
    ? { pathname: '/(host)/[hostId]/pane/[paneId]' as const, params: { hostId, paneId } }
    : { pathname: '/(host)/[hostId]/tiles' as const, params: { hostId } }
}
