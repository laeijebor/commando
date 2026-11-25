import { boardItemKeyForPr, boardItemKeyForUrl, boardPrRefForUrl, normalizeBoardUrl } from '../shared/board.js'
import type { AgentSessionRef } from '../shared/protocol.js'
import type { BoardStore } from './boards.js'
import type { TurnBriefs } from './turn-briefs.js'

type Turn = Parameters<TurnBriefs['observe']>[0]
/** Markdown destinations and bare URLs, including inline code, excluding fenced code blocks. */
export function extractBoardLinks(message: string, port: number): { url: string; title?: string; pr?: { repo: string; number: number } }[] {
  const bounded = Buffer.from(message.slice(0, 64 * 1024)).subarray(0, 64 * 1024).toString('utf8')
  const lines = bounded.split(/\r?\n/), visible: string[] = []
  let fence: { char: string; length: number } | undefined
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.length && /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))) fence = undefined
      continue
    }
    if (marker) { fence = { char: marker[0], length: marker.length }; continue }
    visible.push(line)
  }
  const text = visible.join('\n'), results: ReturnType<typeof extractBoardLinks> = [], seen = new Set<string>()
  const titles = new Map<number, string>()
  let labelStart = -1, labelEnd = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') { labelStart = i + 1; labelEnd = -1 }
    else if (text[i] === ']' && labelStart >= 0) labelEnd = i
    else if (text[i] === '(' && labelStart >= 0 && labelEnd === i - 1) {
      titles.set(i + 1 + (text[i + 1] === '<' ? 1 : 0), text.slice(labelStart, Math.min(labelEnd, labelStart + 500)))
      labelStart = labelEnd = -1
    } else if (text[i] === '\n') labelStart = labelEnd = -1
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\u0000-\u001f]+/gi)) {
    const candidate = match[0]
    if (candidate.length > 2048) continue
    const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
    for (const char of candidate) if (Object.hasOwn(counts, char)) counts[char]++
    const opening: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    let end = candidate.length
    while (end) {
      const char = candidate[end - 1]
      if ('.,;:!?'.includes(char)) end--
      else if (opening[char] && counts[char] > counts[opening[char]]) { counts[char]--; end-- }
      else break
    }
    const raw = candidate.slice(0, end)
    try {
      const url = normalizeBoardUrl(raw), parsed = new URL(url)
      if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === port) continue
      // Local file paths and file: image references are not http(s) candidates to begin with.
      if (url.length > 2048) continue
      const pr = boardPrRefForUrl(url)
      const key = pr ? boardItemKeyForPr(pr.repo, pr.number) : boardItemKeyForUrl(url)
      if (seen.has(key)) continue
      seen.add(key); results.push({ url, title: titles.get(match.index), ...(pr ? { pr } : {}) })
      if (results.length === 20) break
    } catch { /* Invalid URLs/credentials are not board references. */ }
  }
  return results
}

export class BoardLinkHarvest {
  private readonly previous = new Map<string, { working: boolean; ended?: number; session?: string }>()
  constructor(private readonly store: BoardStore, private readonly port: number) {}
  remove(paneId: string): void { this.previous.delete(paneId) }
  observe(turn: Turn, prompt?: string, agentSession?: AgentSessionRef): void {
    const { status, targetId } = turn, prior = this.previous.get(status.paneId)
    const session = status.agentSessionId
    const ended = turn.chat ? status.settledAt : status.details?.recap?.completedAt ?? status.settledAt ?? status.updatedAt
    const previous = prior?.session === session ? prior : undefined
    this.previous.set(status.paneId, { working: status.status === 'working' || (!!previous?.working && status.status !== 'done'), ended: status.status === 'done' ? ended : previous?.ended, session })
    if (previous?.working && status.status === 'done' && !turn.finalMessage) this.previous.set(status.paneId, { ...this.previous.get(status.paneId)!, working: true })
    if (turn.restored || status.status !== 'done' || !turn.finalMessage || !previous || (!previous.working && previous.ended === ended)) return
    // Restored done baselines never harvest; each newly finished run is handled once.
    agentSession ??= status.agentSessionId ? { provider: status.provider, id: status.agentSessionId } : undefined
    const origin = { at: ended ?? status.updatedAt, ...(agentSession ? { agentSession } : {}), ...(prompt ? { prompt: prompt.slice(0, 8192).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') } : {}) }
    for (const link of extractBoardLinks(turn.finalMessage, this.port)) {
      const key = link.pr ? boardItemKeyForPr(link.pr.repo, link.pr.number) : boardItemKeyForUrl(link.url)
      const existing = this.store.get(targetId).items.find((i) => i.key === key)
      // A harvest must not overwrite a title learned from GitHub or supplied by the user.
      if (existing) {
        if (link.pr && link.title && existing.title === `${existing.ref.pr?.repo}#${existing.ref.pr?.number}`) this.store.upsert(targetId, { ...existing, title: link.title })
        continue
      }
      this.store.capture(targetId, { key, kind: link.pr ? 'pr' : 'link', title: link.title || (link.pr ? `${link.pr.repo}#${link.pr.number}` : link.url).slice(0, 500), ref: { url: link.url, ...(link.pr ? { pr: link.pr } : {}) }, origin }, JSON.stringify([status.agentSessionId, ended, link.url]))
    }
  }
}
