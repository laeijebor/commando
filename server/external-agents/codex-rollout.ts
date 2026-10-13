import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentProcess } from './process-scan.js'
import { firstLine } from './process-scan.js'
import { firstJsonLine, firstUserMessage, JsonlTail, promptMatches, record, textContent, type AgentProgress, type ProgressSource } from './progress.js'

export interface RolloutCandidate {
  path: string
  cwd: string
  originator: string
  startedAt: number
  sessionId?: string
  prompt?: string
}

export interface ResumeRolloutLookup {
  candidate?: RolloutCandidate
  retryAt: number
}

export const RESUME_LOOKUP_BACKOFF_MS = 15_000

async function readRolloutCandidate(path: string): Promise<RolloutCandidate | undefined> {
  const line = record(await firstJsonLine(path).catch(() => undefined))
  const payload = record(line.payload)
  const startedAt = Date.parse(typeof payload.timestamp === 'string' ? payload.timestamp : String(line.timestamp))
  if (line.type !== 'session_meta' || typeof payload.cwd !== 'string' || typeof payload.originator !== 'string' || !Number.isFinite(startedAt)) return undefined
  return { path, cwd: payload.cwd, originator: payload.originator, startedAt, sessionId: typeof payload.id === 'string' ? payload.id : undefined }
}

/** Old resumed sessions need an archive lookup; cap directory and metadata reads per attempt. */
export async function findResumeRollout(sessionsDir: string, resumeId: string, now: number, cache: Map<string, ResumeRolloutLookup>, maxDirectories = 4_096): Promise<RolloutCandidate | undefined> {
  const known = cache.get(resumeId)
  if (known && (known.candidate || now < known.retryAt)) return known.candidate
  let directories = 0
  let files = 0
  const walk = async (dir: string, depth: number): Promise<RolloutCandidate | undefined> => {
    if (depth > 6 || directories >= maxDirectories || files >= 64) return undefined
    directories += 1
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const candidate = await walk(path, depth + 1)
        if (candidate) return candidate
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${resumeId}.jsonl`)) {
        if (files >= 64) break
        files += 1
        const candidate = await readRolloutCandidate(path)
        if (candidate?.sessionId === resumeId) return candidate
      }
    }
    return undefined
  }
  const candidate = await walk(sessionsDir, 0)
  cache.set(resumeId, { candidate, retryAt: now + RESUME_LOOKUP_BACKOFF_MS })
  return candidate
}

function codexUserText(value: unknown): string {
  const line = record(value)
  const payload = record(line.payload)
  const item = record(payload.item)
  return line.type === 'event_msg' && payload.type === 'item_completed' && item.type === 'UserMessage' ? textContent(item.content) : ''
}

export async function matchRollout(candidates: readonly RolloutCandidate[], run: AgentProcess, cwd: string, claimed: ReadonlySet<string>): Promise<RolloutCandidate | undefined> {
  const eligible = candidates.filter((candidate) => !claimed.has(candidate.path) && candidate.cwd === cwd && candidate.originator.startsWith('codex_exec')
    && (run.resume ? !run.resumeId || candidate.sessionId === run.resumeId : candidate.startedAt >= run.startedAt - 5_000 && candidate.startedAt <= run.startedAt + 120_000))
    .sort((a, b) => (run.resume ? b.startedAt - a.startedAt : Math.abs(a.startedAt - run.startedAt) - Math.abs(b.startedAt - run.startedAt)))
  if (run.prompt) {
    for (const candidate of eligible) {
      const prompt = !run.resume && candidate.prompt !== undefined ? candidate.prompt
        : await firstUserMessage(candidate.path, codexUserText, run.resume ? run.startedAt - 1_000 : undefined).catch(() => undefined)
      if (!run.resume && prompt) candidate.prompt = prompt
      if (promptMatches(prompt, run.prompt)) return candidate
    }
  }
  return eligible[0]
}

export async function rolloutCandidates(sessionsDir: string, now: number, cache = new Map<string, RolloutCandidate>()): Promise<RolloutCandidate[]> {
  const dates = [new Date(now), new Date(now - 24 * 60 * 60 * 1000)]
  const dirs = [...new Set(dates.map((date) => join(sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))))]
  const candidates = await Promise.all(dirs.map(async (dir) => {
    const files = await readdir(dir).catch(() => [])
    return Promise.all(files.filter((name) => /^rollout-.*\.jsonl$/.test(name)).map(async (name) => {
      const path = join(dir, name)
      const known = cache.get(path)
      if (known) return known
      const candidate = await readRolloutCandidate(path)
      if (!candidate) return null
      cache.set(path, candidate)
      return candidate
    }))
  }))
  const found = candidates.flat().filter((value) => value !== null)
  const paths = new Set(found.map((candidate) => candidate.path))
  for (const path of cache.keys()) { if (!paths.has(path)) cache.delete(path) }
  return found
}

export function completedCommand(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || !value.every((word) => typeof word === 'string')) return ''
  if (/\/(?:sh|bash|zsh)$/.test(value[0] ?? '') && /^-[a-z]*c[a-z]*$/.test(value[1] ?? '')) return value.slice(2).join(' ')
  return value.join(' ')
}

export function parseCodexLine(value: unknown, progress: AgentProgress): void {
  const line = record(value)
  const payload = record(line.payload)
  if (!['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(String(line.type))) return
  const timestamp = Date.parse(String(line.timestamp))
  if (Number.isFinite(timestamp)) progress.lastEventAt = Math.max(progress.lastEventAt ?? 0, timestamp)
  if (line.type === 'turn_context') {
    if (typeof payload.model === 'string') progress.model = payload.model
    if (typeof payload.effort === 'string') progress.effort = payload.effort
  }
  if (line.type !== 'event_msg') return
  if (payload.type === 'task_complete') {
    progress.completed = true
    if (typeof payload.duration_ms === 'number') progress.durationMs = payload.duration_ms
    if (typeof payload.last_agent_message === 'string') progress.summary = firstLine(payload.last_agent_message)
  }
  if (payload.type !== 'item_completed') return
  const item = record(payload.item)
  if (item.type === 'UserMessage' && !progress.label) progress.label = firstLine(textContent(item.content)) || undefined
  if (item.type === 'AgentMessage') {
    const text = firstLine(textContent(item.content))
    if (text) progress.lastAction = text
  }
  if (item.type === 'CommandExecution') {
    const command = completedCommand(item.command)
    if (command) progress.lastAction = `$ ${command}`
  }
  if (typeof item.type === 'string' && /(?:ToolCall|ToolExecution|CommandExecution|FileChange|WebSearch|ImageGeneration)/.test(item.type)) progress.toolUses = (progress.toolUses ?? 0) + 1
}

export async function codexSource(candidate: RolloutCandidate, run: Pick<AgentProcess, 'resume' | 'startedAt'>): Promise<ProgressSource> {
  const progress: AgentProgress = { toolUses: 0 }
  const tail = new JsonlTail(candidate.path, (line) => {
    if (run.resume && !(Date.parse(String(record(line).timestamp)) >= run.startedAt - 1_000)) return
    parseCodexLine(line, progress)
  })
  return { path: candidate.path, poll: async () => { await tail.poll(); return { ...progress } } }
}
