/** GitHub PR and Linear issue links in agent replies, recognised so the chat can show them as chips and cards. */

export type PrLinkTab = 'Description' | 'Checks' | 'Conversation' | 'Diff'
export type GithubPrLink = { repo: string; number: number; url: string; tab: PrLinkTab }
export type LinearIssueLink = { workspace: string; identifier: string; url: string }

const GITHUB_PR = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(\/(?:files|commits|checks))?\/?(?:[?#]\S*)?$/
const LINEAR_ISSUE = /^https:\/\/linear\.app\/([a-z0-9][a-z0-9-]{0,63})\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-[1-9]\d{0,8})(?:\/[^\s?#/]{0,200})?\/?(?:[?#]\S*)?$/

/** `https://github.com/<owner>/<repo>/pull/<n>`, optionally with `/files`, `/commits`, `/checks`, a query or a fragment. */
export function parseGithubPrLink(href: string | undefined): GithubPrLink | null {
  if (!href || href.length > 2048) return null
  const match = GITHUB_PR.exec(href)
  if (!match || match[2] === '.' || match[2] === '..') return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number)) return null
  const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
  const tab: PrLinkTab = match[4] === '/files' || match[4] === '/commits' ? 'Diff' : match[4] === '/checks' ? 'Checks'
    : /^(?:issuecomment|discussion_|pullrequestreview)/.test(fragment) ? 'Conversation' : 'Description'
  return { repo: `${match[1]}/${match[2]}`, number, url: href, tab }
}

/** `https://linear.app/<workspace>/issue/<KEY-123>/<slug?>`. A bare `KEY-123` is not an issue link: too many false positives. */
export function parseLinearIssueLink(href: string | undefined): LinearIssueLink | null {
  if (!href || href.length > 2048) return null
  const match = LINEAR_ISSUE.exec(href)
  return match ? { workspace: match[1], identifier: match[2].toUpperCase(), url: href } : null
}

export type RichLink = ({ kind: 'pr' } & GithubPrLink) | ({ kind: 'linear' } & LinearIssueLink)
export function parseRichLink(href: string | undefined): RichLink | null {
  const pr = parseGithubPrLink(href)
  if (pr) return { kind: 'pr', ...pr }
  const issue = parseLinearIssueLink(href)
  return issue ? { kind: 'linear', ...issue } : null
}

export type PrChipState = 'open' | 'draft' | 'merged' | 'closed'
/** What a PR chip shows beyond `owner/repo#n`. */
export type PrChipSummary = { title: string; state: PrChipState; author?: string; branch?: string }

/** What a Linear chip shows beyond the identifier. */
export type LinearChipIssue = {
  identifier: string
  title: string
  url: string
  state?: { name: string; color?: string; type?: string }
  assignee?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined
const COLOR = /^#[0-9a-f]{3,8}$/i

export function parsePrChipSummary(value: unknown): PrChipSummary | null {
  if (!isRecord(value)) return null
  const title = text(value.title, 500)
  const state = value.state
  if (!title || (state !== 'open' && state !== 'draft' && state !== 'merged' && state !== 'closed')) return null
  const author = text(value.author, 100)
  const branch = text(value.branch, 255)
  return { title, state, ...(author ? { author } : {}), ...(branch ? { branch } : {}) }
}

export function parseLinearChipIssue(value: unknown): LinearChipIssue | null {
  if (!isRecord(value)) return null
  const identifier = text(value.identifier, 32)
  const title = text(value.title, 500)
  const url = text(value.url, 2048)
  if (!identifier || !title || !url || !parseLinearIssueLink(url)) return null
  const rawState = isRecord(value.state) ? value.state : undefined
  const stateName = text(rawState?.name, 100)
  const color = typeof rawState?.color === 'string' && COLOR.test(rawState.color) ? rawState.color : undefined
  const type = text(rawState?.type, 40)
  const assignee = text(value.assignee, 100)
  return {
    identifier, title, url,
    ...(stateName ? { state: { name: stateName, ...(color ? { color } : {}), ...(type ? { type } : {}) } } : {}),
    ...(assignee ? { assignee } : {}),
  }
}
