import { useMemo, useRef } from 'react'
import type { LinearChipIssue, PrChipSummary, PrLinkTab } from '../../shared/rich-links'
import type { PanePrSummary, PrsApiClient, PrSummary } from '../prsApi'
import { cachedPanePrs, cachedPrSummary, usePanePrs } from '../prStore'
import type { RichLinkServices } from './RichLinks'

const NO_PRS: Pick<PrsApiClient, 'pane'> = { pane: () => Promise.reject(new Error('Pull requests are unavailable')) }
const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`

function chipSummary(pr: PrSummary | PanePrSummary): PrChipSummary {
  const author = 'author' in pr ? pr.author : pr.preview?.author
  const branch = 'headRefName' in pr ? pr.headRefName : pr.preview?.headRefName
  return { title: pr.title, state: pr.state === 'open' && pr.isDraft ? 'draft' : pr.state, ...(author ? { author } : {}), ...(branch ? { branch } : {}) }
}

/**
 * What a chat's PR and Linear chips use. PR data comes from lists Commando already holds when it can,
 * else from the daemon's cached single-PR read. Quick Look opens only PRs linked to the pane,
 * because only those have a side-panel tab; the chips link to GitHub for the rest.
 */
export function useRichLinkServices({ prsApi, paneId, connected, linearIssue, onOpenPr }: {
  prsApi?: PrsApiClient
  paneId: string
  connected: boolean
  linearIssue?: (url: string) => Promise<LinearChipIssue | null>
  onOpenPr?: (repo: string, number: number, tab: PrLinkTab) => void
}): RichLinkServices {
  // A background read of the list the pane's PR strip already polls, so this adds no polling.
  const list = usePanePrs(paneId, prsApi ?? NO_PRS, { background: true, enabled: Boolean(prsApi) && connected })
  const linked = list?.pullRequests.map((pr) => prKey(pr.repo, pr.number)).sort().join(' ') ?? ''
  const openPrRef = useRef(onOpenPr)
  openPrRef.current = onOpenPr
  const canOpenPr = Boolean(onOpenPr)
  // Stable loaders: a new identity would make every chip fetch again.
  const prSummary = useMemo(() => prsApi ? async (repo: string, number: number) => {
    const known = cachedPrSummary(prsApi, repo, number)
      ?? cachedPanePrs(prsApi, paneId)?.pullRequests.find((pr) => prKey(pr.repo, pr.number) === prKey(repo, number))
    return known ? chipSummary(known) : prsApi.summary(repo, number)
  } : undefined, [prsApi, paneId])
  return useMemo<RichLinkServices>(() => {
    const keys = new Set(linked.split(' '))
    const hasQuickLook = (repo: string, number: number) => keys.has(prKey(repo, number))
    return {
      ...(prSummary ? { prSummary } : {}),
      ...(linearIssue ? { linearIssue } : {}),
      ...(canOpenPr ? { hasQuickLook, openPr: (repo: string, number: number, tab: PrLinkTab) => openPrRef.current?.(repo, number, tab) } : {}),
    }
  }, [prSummary, linearIssue, canOpenPr, linked])
}
