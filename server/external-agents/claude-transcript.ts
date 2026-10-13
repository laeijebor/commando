import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { firstLine, type AgentProcess } from './process-scan.js'
import { firstUserMessage, JsonlTail, promptMatches, record, textContent, type AgentProgress, type ProgressSource } from './progress.js'

export async function findClaudeTranscript(configDirs: readonly string[], cwd: string, startedAt: number, claimed: ReadonlySet<string>, prompt?: string, run?: Pick<AgentProcess, 'resume' | 'resumeId'>): Promise<string | undefined> {
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const candidates = await Promise.all([...new Set(configDirs)].map(async (configDir) => {
    const dir = join(configDir, 'projects', project)
    const files = run?.resumeId ? [`${run.resumeId}.jsonl`] : await readdir(dir).catch(() => [])
    return Promise.all(files.filter((name) => name.endsWith('.jsonl') && !claimed.has(name) && !claimed.has(join(dir, name))).map(async (name) => {
      const path = join(dir, name)
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) return null
      if (run?.resumeId) return { path, createdAt: info.mtimeMs }
      if (run?.resume) return info.mtimeMs >= startedAt ? { path, createdAt: info.mtimeMs } : null
      return info.birthtimeMs >= startedAt ? { path, createdAt: info.birthtimeMs } : null
    }))
  }))
  const eligible = candidates.flat().filter((value) => value !== null)
    .sort((a, b) => run?.resume ? b.createdAt - a.createdAt : Math.abs(a.createdAt - startedAt) - Math.abs(b.createdAt - startedAt))
  if (run?.resumeId) return eligible[0]?.path
  if (prompt) {
    for (const candidate of eligible) {
      const text = await firstUserMessage(candidate.path, (value) => {
        const line = record(value)
        return line.type === 'user' ? textContent(record(line.message).content) : ''
      }, run?.resume ? startedAt - 1_000 : -Infinity).catch(() => undefined)
      if (promptMatches(text, prompt)) return candidate.path
    }
    if (run?.resume) return undefined
  }
  return eligible[0]?.path
}

export function parseClaudeLine(value: unknown, progress: AgentProgress): void {
  const line = record(value)
  if (line.type !== 'user' && line.type !== 'assistant') return
  const message = record(line.message)
  const timestamp = Date.parse(String(line.timestamp))
  if (Number.isFinite(timestamp)) progress.lastEventAt = Math.max(progress.lastEventAt ?? 0, timestamp)
  if (line.type === 'user' && !progress.label) progress.label = firstLine(textContent(message.content)) || undefined
  if (line.type !== 'assistant') return
  if (typeof message.model === 'string') progress.model = message.model
  if (!Array.isArray(message.content)) return
  for (const value of message.content) {
    const block = record(value)
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      progress.toolUses = (progress.toolUses ?? 0) + 1
      const input = record(block.input)
      progress.lastAction = block.name === 'Bash' && typeof input.command === 'string' ? `$ ${input.command}` : block.name
    } else if (block.type === 'text' && typeof block.text === 'string' && firstLine(block.text)) progress.lastAction = firstLine(block.text)
  }
}

export function claudeSource(path: string, run?: Pick<AgentProcess, 'resume' | 'startedAt'>): ProgressSource {
  const progress: AgentProgress = { toolUses: 0 }
  const tail = new JsonlTail(path, (line) => {
    if (run?.resume && !(Date.parse(String(record(line).timestamp)) >= run.startedAt - 1_000)) return
    parseClaudeLine(line, progress)
  })
  return { path, poll: async () => { await tail.poll(); return { ...progress } } }
}
