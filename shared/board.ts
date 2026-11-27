import type { AgentSessionRef, WebPaneEngine } from './protocol.js'

export type BoardItemKind = 'pr' | 'canvas' | 'redline' | 'slides' | 'guide' | 'page' | 'diagram' | 'screenshot' | 'video' | 'link' | 'file' | 'clip'
export type BoardItemSource = 'auto' | 'agent' | 'user'
/** For non-tile kinds, 'open' means available: links, clips and PRs always are;
 * file-backed items are available while ref.path exists. Tile kinds retain tab/snapshot state. */
export type BoardItemState = 'open' | 'closed' | 'snapshot' | 'missing'
export type BoardItem = {
  key: string
  kind: BoardItemKind
  title: string
  source: BoardItemSource
  ref: { engine?: WebPaneEngine; url?: string; path?: string; artifactId?: string; manifest?: string; file?: string; webPaneId?: string; snapshotId?: string; snapshotAt?: number; pr?: { repo: string; number: number } }
  origin?: { at: number; agentSession?: AgentSessionRef; prompt?: string }
  caption?: string
  tone?: 'decision' | 'gotcha' | 'note'
  pinned?: boolean
  thumb?: { hash: string; w: number; h: number }
  /** image/favicon are local SHA-256 thumbnail hashes, served at /api/boards/thumbs/:hash/:width (320 or 960). */
  preview?: { title?: string; description?: string; siteName?: string; image?: string; favicon?: string }
  closedAt?: number
  addedAt: number
  updatedAt: number
}
export type BoardGroup = { id: string; title: string; tone?: 'accent' | 'blue' | 'green' | 'amber' | 'pink' | 'teal'; x: number; y: number; w: number; h: number; by: BoardItemSource }
export type BoardPlacement = { group?: string; x: number; y: number; fixed?: boolean }
export type BoardLink = { id: string; from: string; to: string; label?: string }
export type Board = { targetId: string; rev: number; items: BoardItem[]; groups: BoardGroup[]; placements: Record<string, BoardPlacement>; links: BoardLink[] }
export type BoardView = Omit<Board, 'items'> & { items: (BoardItem & { state: BoardItemState })[] }

export const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const BOARD_ARTIFACT_ID = /^[0-9a-f]{16}$/
export const BOARD_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const BOARD_ITEM_KEY = /^(?:canvas|guide|redline|page|pr|url|file|clip):[^\u0000-\u001f\u007f]{1,8192}$/
export const BOARD_ITEM_KINDS: readonly BoardItemKind[] = ['pr', 'canvas', 'redline', 'slides', 'guide', 'page', 'diagram', 'screenshot', 'video', 'link', 'file', 'clip']

export function normalizeBoardUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL must use http(s) without credentials')
  url.hostname = url.hostname.toLowerCase()
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.hash.startsWith('#/')) url.hash = ''
  return url.href
}

// Callers canonicalize filesystem paths with realpath before building identities.
export const boardItemKeyForCanvas = (realDir: string, manifest = 'canvas.json') => `canvas:${realDir}#${manifest}`
export const boardItemKeyForGuide = (realDir: string, file: string) => `guide:${realDir}#${file}`
export const boardItemKeyForRedline = (url: string) => `redline:${normalizeBoardUrl(url)}`
export const boardItemKeyForPage = (url: string) => `page:${normalizeBoardUrl(url)}`
export const boardItemKeyForUrl = (url: string) => `url:${normalizeBoardUrl(url)}`
export const boardItemKeyForFile = (realPath: string) => `file:${realPath}`
export const boardItemKeyForPr = (repo: string, number: number) => `pr:${repo.toLowerCase()}#${number}`
export const boardItemKeyForClip = (id: string) => `clip:${id}`

/** Shared identity for PR URLs captured by chat, hooks or the Board CLI. */
export function boardPrRefForUrl(value: string): { repo: string; number: number } | undefined {
  let url: URL
  try { url = new URL(normalizeBoardUrl(value)) } catch { return }
  if (url.hostname !== 'github.com') return
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(url.pathname)
  const number = match ? Number(match[3]) : 0
  if (match && Number.isSafeInteger(number) && number > 0) return { repo: `${match[1]}/${match[2]}`, number }
}
