import type { PanePrLink, PanePrList, PanePrRelation, PanePrSummary } from './pr-types.js'

/** How a pane relates to one of its PRs; a list without links comes from a daemon that only listed created PRs. */
export function panePrLink(list: Pick<PanePrList, 'links'>, pr: Pick<PanePrSummary, 'repo' | 'number' | 'createdAt'>): PanePrLink {
  const repo = pr.repo.toLowerCase()
  return list.links?.find((link) => link.number === pr.number && link.repo.toLowerCase() === repo)
    ?? { repo: pr.repo, number: pr.number, relation: 'created', at: Date.parse(pr.createdAt) }
}

export function panePrRelation(list: Pick<PanePrList, 'links'>, pr: Pick<PanePrSummary, 'repo' | 'number' | 'createdAt'>): PanePrRelation {
  return panePrLink(list, pr).relation
}
