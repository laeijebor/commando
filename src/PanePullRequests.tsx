import type { PanePrList, PrsApiClient } from './prsApi'
import { usePanePrs } from './prStore'

export function usePanePullRequests(
  paneId: string,
  api: Pick<PrsApiClient, 'pane'>,
  connected: boolean,
  background = false,
): PanePrList | null {
  return usePanePrs(paneId, api, { background, enabled: connected })
}
