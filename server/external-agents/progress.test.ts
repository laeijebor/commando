import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeSource, findClaudeTranscript, parseClaudeLine } from './claude-transcript.js'
import { codexSource, findResumeRollout, matchRollout, parseCodexLine, RESUME_LOOKUP_BACKOFF_MS, rolloutCandidates, type ResumeRolloutLookup, type RolloutCandidate } from './codex-rollout.js'
import { JsonlTail, type AgentProgress } from './progress.js'
import { recognizeAgent, type AgentProcess } from './process-scan.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'external-progress-')); dirs.push(dir); return dir }
const start = Date.parse('2026-10-13T06:30:10.465Z')
const run: AgentProcess = { pid: 50, ppid: 40, pgid: 50, tty: '??', startedAt: start, command: 'codex exec prompt', runtime: 'codex', label: 'codex exec', resume: false }
const candidate = (path: string, overrides: Partial<RolloutCandidate> = {}): RolloutCandidate => ({ path, cwd: '/work/example', originator: 'codex_exec', startedAt: start, ...overrides })
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
const event = (text: string) => JSON.stringify({ timestamp: '2026-10-13T06:31:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } } }) + '\n'

describe('Codex rollouts', () => {
  it('matches cwd, exec origin and start window, preferring an unclaimed file', async () => {
    const candidates = [candidate('claimed'), candidate('next', { startedAt: start + 4_000 }), candidate('old', { startedAt: start - 5_001 }), candidate('late', { startedAt: start + 120_001 }), candidate('other', { cwd: '/other' }), candidate('interactive', { originator: 'codex_cli' })]
    expect((await matchRollout(candidates, run, '/work/example', new Set(['claimed'])))?.path).toBe('next')
    expect((await matchRollout(candidates, run, '/work/example', new Set()))?.path).toBe('claimed')
    expect(await matchRollout([candidate('claimed')], run, '/work/example', new Set(['claimed']))).toBeUndefined()
    expect(await matchRollout(candidates.slice(2), run, '/work/example', new Set())).toBeUndefined()
    expect((await matchRollout([candidate('lower', { startedAt: start - 5_000 })], run, '/work/example', new Set()))?.path).toBe('lower')
    expect((await matchRollout([candidate('upper', { startedAt: start + 120_000 })], run, '/work/example', new Set()))?.path).toBe('upper')
  })

  it('matches simultaneous same-cwd runs by their normalised prompt before time proximity', async () => {
    const folder = await temp()
    const first = candidate(join(folder, 'first.jsonl'), { startedAt: start + 100 })
    const second = candidate(join(folder, 'second.jsonl'), { startedAt: start + 500 })
    for (const [file, prompt] of [[first, 'Review parser.\nCheck edge cases.'], [second, 'Review scanner. Check progress.']] as const) {
      await writeFile(file.path, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } }) + '\n')
    }
    const selected = await matchRollout([first, second], { ...run, prompt: 'Review scanner.   Check progress.' }, '/work/example', new Set())
    expect(selected?.path).toBe(second.path)
    expect((await matchRollout([first, second], { ...run, prompt: 'Review parser. Check edge cases.' }, '/work/example', new Set([second.path])))?.path).toBe(first.path)
    expect((await matchRollout([first, second], { ...run, prompt: 'No matching prompt' }, '/work/example', new Set()))?.path).toBe(first.path)
  })

  it('reads today and yesterday metadata while ignoring other days and malformed files', async () => {
    const dir = await temp()
    for (const day of ['12', '13', '11']) {
      const folder = join(dir, '2026', '10', day)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'rollout-sample.jsonl'), JSON.stringify({ timestamp: `2026-10-${day}T06:30:10Z`, type: 'session_meta', payload: { id: day, cwd: '/work/example', originator: 'codex_exec' } }) + '\n')
      await writeFile(join(folder, 'rollout-bad.jsonl'), 'broken\n')
    }
    const candidates = await rolloutCandidates(dir, new Date(2026, 9, 13, 12).getTime())
    expect(candidates.map((value) => value.sessionId).sort()).toEqual(['12', '13'])
  })

  it('finds old resumed rollouts newest year/month/day first and caches a successful lookup', async () => {
    const dir = await temp()
    const id = '00000000-0000-4000-8000-000000000001'
    const paths: string[] = []
    for (const date of ['2024/12/31', '2025/01/01', '2025/09/02', '2025/09/03']) {
      const folder = join(dir, date)
      await mkdir(folder, { recursive: true })
      const path = join(folder, `rollout-example-${id}.jsonl`)
      await writeFile(path, JSON.stringify({ timestamp: `${date.replaceAll('/', '-')}T06:30:10Z`, type: 'session_meta', payload: { id, cwd: '/work/example', originator: 'codex_exec' } }) + '\n')
      paths.push(path)
    }
    expect(await rolloutCandidates(dir, start)).toEqual([])
    const cache = new Map<string, ResumeRolloutLookup>()
    const found = await findResumeRollout(dir, id, start, cache)
    expect(found?.path).toBe(paths[3])
    expect((await matchRollout([found!], { ...run, resume: true, resumeId: id }, '/work/example', new Set()))?.path).toBe(paths[3])
    expect(await matchRollout([found!], { ...run, resume: true, resumeId: id }, '/other', new Set())).toBeUndefined()
    expect(await matchRollout([found!], { ...run, resume: true, resumeId: id }, '/work/example', new Set([found!.path]))).toBeUndefined()
    await rm(dir, { recursive: true })
    expect(await findResumeRollout(dir, id, start + RESUME_LOOKUP_BACKOFF_MS, cache)).toBe(found)
  })

  it('caches missing resume ids until the retry back-off expires', async () => {
    const dir = await temp()
    const id = '00000000-0000-4000-8000-000000000001'
    const cache = new Map<string, ResumeRolloutLookup>()
    expect(await findResumeRollout(dir, id, start, cache)).toBeUndefined()
    expect(cache.has(id)).toBe(true)
    const folder = join(dir, '2025', '09', '03')
    await mkdir(folder, { recursive: true })
    const path = join(folder, `rollout-example-${id}.jsonl`)
    await writeFile(path, JSON.stringify({ timestamp: '2025-09-03T06:30:10Z', type: 'session_meta', payload: { id, cwd: '/work/example', originator: 'codex_exec' } }) + '\n')
    expect(await findResumeRollout(dir, id, start + RESUME_LOOKUP_BACKOFF_MS - 1, cache)).toBeUndefined()
    expect((await findResumeRollout(dir, id, start + RESUME_LOOKUP_BACKOFF_MS, cache))?.path).toBe(path)
  })

  it('bounds archive directory traversal and ignores malformed or mismatched metadata', async () => {
    const dir = await temp()
    const id = '00000000-0000-4000-8000-000000000001'
    const newer = join(dir, '2026', '09', '03')
    const older = join(dir, '2025', '09', '03')
    await mkdir(newer, { recursive: true })
    await mkdir(older, { recursive: true })
    await writeFile(join(newer, `rollout-z-${id}.jsonl`), 'garbled\n')
    await writeFile(join(newer, `rollout-y-${id}.jsonl`), JSON.stringify({ timestamp: '2026-09-03T06:30:10Z', type: 'session_meta', payload: { id: 'other-id', cwd: '/work/example', originator: 'codex_exec' } }) + '\n')
    const path = join(older, `rollout-x-${id}.jsonl`)
    await writeFile(path, JSON.stringify({ timestamp: '2025-09-03T06:30:10Z', type: 'session_meta', payload: { id, cwd: '/work/example', originator: 'codex_exec' } }) + '\n')
    const cache = new Map<string, ResumeRolloutLookup>()
    expect(await findResumeRollout(dir, id, start, cache, 4)).toBeUndefined()
    expect((await findResumeRollout(dir, id, start + RESUME_LOOKUP_BACKOFF_MS, cache))?.path).toBe(path)
  })

  it('parses an anonymised captured rollout without counting instructions or reasoning as tools', async () => {
    const progress: AgentProgress = {}
    for (const line of (await fixture('codex-exec')).trim().split('\n')) parseCodexLine(JSON.parse(line), progress)
    expect(progress).toMatchObject({ label: 'Review the sample change.', model: 'gpt-5.6-terra', effort: 'medium', toolUses: 1, lastAction: '$ git diff --stat', completed: true, summary: 'Review finished.' })
    parseCodexLine({ type: 'response_item', payload: { role: 'user', content: [{ text: 'Developer instructions' }] } }, progress)
    parseCodexLine({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } }, progress)
    parseCodexLine({ type: 'unexpected', timestamp: '2099-01-01' }, progress)
    expect(progress.toolUses).toBe(1)
    expect(progress.label).toBe('Review the sample change.')
    parseCodexLine({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange' } } }, progress)
    expect(progress.toolUses).toBe(2)
  })

  it('buffers partial lines and UTF-8, ignores malformed lines, and counts each tool once', async () => {
    const path = join(await temp(), 'run.jsonl')
    const data = Buffer.from(event('Reading café'))
    const split = data.indexOf(Buffer.from('é')) + 1
    await writeFile(path, data.subarray(0, split))
    const source = await codexSource(candidate(path), run)
    expect((await source.poll()).lastAction).toBeUndefined()
    await appendFile(path, data.subarray(split))
    expect((await source.poll()).lastAction).toBe('Reading café')
    await appendFile(path, 'garbled\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'] } } }) + '\n')
    expect(await source.poll()).toMatchObject({ lastAction: '$ npm test', toolUses: 1 })
    expect((await source.poll()).toolUses).toBe(1)
  })

  it('keeps resumed events written before attachment and ignores events before start minus one second', async () => {
    const path = join(await temp(), 'run.jsonl')
    await writeFile(path, await fixture('codex-exec'))
    const resumed = { ...run, resume: true, resumeId: 'session', startedAt: Date.parse('2026-10-13T06:40:00Z') }
    const old = candidate(path, { startedAt: start - 86_400_000, sessionId: 'session' })
    expect((await matchRollout([old], resumed, '/work/example', new Set()))?.path).toBe(path)
    const message = JSON.parse(event('Resumed review')) as Record<string, unknown>
    message.timestamp = '2026-10-13T06:39:59Z'
    await appendFile(path, JSON.stringify(message) + '\n')
    const source = await codexSource(old, resumed)
    expect(await source.poll()).toEqual({ toolUses: 0, lastAction: 'Resumed review', lastEventAt: resumed.startedAt - 1_000 })
    expect((await source.poll()).completed).toBeUndefined()
  })

  it('drains a large newly written chunk through its completion event', async () => {
    const path = join(await temp(), 'run.jsonl')
    const padding = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1_100_000) } }) + '\n'
    await writeFile(path, padding + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Finished.' } }) + '\n')
    const source = await codexSource(candidate(path), run)
    expect(await source.poll()).toMatchObject({ completed: true, summary: 'Finished.' })
  })

  it('restarts the byte offset when a file is truncated', async () => {
    const path = join(await temp(), 'run.jsonl')
    await writeFile(path, event('Long first message'))
    const values: unknown[] = []
    const tail = new JsonlTail(path, (value) => values.push(value))
    await tail.poll()
    await writeFile(path, event('New'))
    await tail.poll()
    expect(values).toHaveLength(2)
  })
})

describe('Claude print transcripts', () => {
  it('counts assistant tools and reports Bash, tool names and assistant text', async () => {
    const progress: AgentProgress = {}
    const lines = (await fixture('claude-print')).trim().split('\n').map((line) => JSON.parse(line) as unknown)
    for (const line of lines.slice(0, 2)) parseClaudeLine(line, progress)
    expect(progress).toMatchObject({ label: 'Review the sample change.', toolUses: 1, lastAction: 'Read' })
    parseClaudeLine(lines[2], progress)
    expect(progress.lastAction).toBe('$ npm test')
    for (const line of lines.slice(3)) parseClaudeLine(line, progress)
    expect(progress).toMatchObject({ toolUses: 2, lastAction: 'Review finished.', model: 'claude-sonnet-4-6', lastEventAt: Date.parse('2026-10-13T06:30:22Z') })
    expect(progress.completed).toBeUndefined()
  })

  it('uses the Claude slug and matches parallel runs by prompt before closest creation time', async () => {
    const config = await temp()
    const cwd = '/work/a_b@c d.é'
    const folder = join(config, 'projects', '-work-a-b-c-d--')
    await mkdir(folder, { recursive: true })
    const first = join(folder, 'first.jsonl')
    const second = join(folder, 'second.jsonl')
    const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n'
    await writeFile(first, userLine('Review parser.\nCheck edge cases.'))
    await writeFile(second, userLine('Review scanner. Check progress.'))
    const startedAt = (await stat(first)).birthtimeMs - 1_000
    expect(await findClaudeTranscript([config], cwd, startedAt, new Set(), 'Review scanner.   Check progress.')).toBe(second)
    expect(await findClaudeTranscript([config], cwd, startedAt, new Set([second]), 'Review parser. Check edge cases.')).toBe(first)
    expect(await findClaudeTranscript([config], cwd, startedAt, new Set())).toBe(first)
  })

  it.each(['--resume', '-r', '--session-id'])('uses an explicit Claude %s transcript born before the process starts', async (flag) => {
    const config = await temp()
    const project = join(config, 'projects', '-work-example')
    await mkdir(project, { recursive: true })
    const id = 'old-session'
    const path = join(project, `${id}.jsonl`)
    await writeFile(path, await fixture('claude-print'))
    const startedAt = Date.now() + 60_000
    const resumed = { ...run, ...recognizeAgent(`claude -p ${flag} ${id} "Review new changes"`)!, startedAt }
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set())).toBeUndefined()
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set(), resumed.prompt, resumed)).toBe(path)
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set([path]), resumed.prompt, resumed)).toBeUndefined()
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set([`${id}.jsonl`]), resumed.prompt, resumed)).toBeUndefined()
  })

  it.each(['-c', '--continue'])('selects the existing transcript most recently modified after start for %s', async (flag) => {
    const config = await temp()
    const project = join(config, 'projects', '-work-example')
    await mkdir(project, { recursive: true })
    const startedAt = Date.now() + 60_000
    for (const [name, offset] of [['old', -5_000], ['recent', 1_000], ['latest', 2_000]] as const) {
      const path = join(project, `${name}.jsonl`)
      await writeFile(path, await fixture('claude-print') + JSON.stringify({ type: 'user', timestamp: new Date(startedAt).toISOString(), message: { content: 'Review new changes' } }) + '\n')
      await utimes(path, new Date(startedAt + offset), new Date(startedAt + offset))
    }
    const continued = recognizeAgent(`claude ${flag} -p "Review new changes"`)!
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set(), continued.prompt, continued)).toBe(join(project, 'latest.jsonl'))
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set([join(project, 'latest.jsonl')]), continued.prompt, continued)).toBe(join(project, 'recent.jsonl'))
  })

  it('matches only the current continuation prompt and excludes known chat session filenames', async () => {
    const config = await temp()
    const project = join(config, 'projects', '-work-example')
    await mkdir(project, { recursive: true })
    const startedAt = Date.now() + 60_000
    const user = (offset: number, text: string) => JSON.stringify({ type: 'user', timestamp: new Date(startedAt + offset).toISOString(), message: { content: text } }) + '\n'
    for (const [name, offset, content] of [
      ['matching', 1_000, user(-1_000, 'Review new changes.\nCheck edge cases.')],
      ['history-only', 2_000, user(-2_000, 'Review new changes. Check edge cases.')],
      ['terminal', 3_000, user(0, 'Review a different project')],
      ['parent-chat', 4_000, user(0, 'Review new changes. Check edge cases.')],
    ] as const) {
      const path = join(project, `${name}.jsonl`)
      await writeFile(path, content)
      await utimes(path, new Date(startedAt + offset), new Date(startedAt + offset))
    }
    const excluded = new Set(['parent-chat.jsonl'])
    const continued = { resume: true }
    expect(await findClaudeTranscript([config], '/work/example', startedAt, excluded, 'Review new changes.   Check edge cases.', continued)).toBe(join(project, 'matching.jsonl'))
    expect(await findClaudeTranscript([config], '/work/example', startedAt, new Set([...excluded, 'matching.jsonl']), 'Review new changes. Check edge cases.', continued)).toBeUndefined()
    expect(await findClaudeTranscript([config], '/work/example', startedAt, excluded, undefined, continued)).toBe(join(project, 'terminal.jsonl'))
  })

  it('keeps new resumed Claude events already written at attachment and ignores history before start minus one second', async () => {
    const path = join(await temp(), 'resumed.jsonl')
    const startedAt = Date.now() + 60_000
    const line = (type: string, offset: number, content: unknown) => JSON.stringify({ type, timestamp: new Date(startedAt + offset).toISOString(), message: { content, model: 'claude-new-model' } }) + '\n'
    await writeFile(path, line('user', -2_000, 'Old prompt') + line('assistant', -2_000, [{ type: 'tool_use', name: 'Bash', input: { command: 'old command' } }])
      + line('user', -1_000, 'New resumed prompt') + line('assistant', 2_000, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]))
    const source = claudeSource(path, { resume: true, startedAt })
    expect(await source.poll()).toMatchObject({ label: 'New resumed prompt', toolUses: 1, lastAction: '$ npm test', lastEventAt: startedAt + 2_000 })
    await appendFile(path, line('assistant', 3_000, [{ type: 'text', text: 'New review finished.' }]))
    expect(await source.poll()).toMatchObject({ label: 'New resumed prompt', toolUses: 1, lastAction: 'New review finished.' })
  })

  it('finds an unclaimed newly created transcript across config directories, and tails it', async () => {
    const dir = await temp()
    const configDirs = ['.claude', '.claudep', '.claudew', '.custom'].map((name) => join(dir, name))
    const paths: string[] = []
    for (const config of configDirs) {
      const folder = join(config, 'projects', '-work-example-repo')
      await mkdir(folder, { recursive: true })
      const path = join(folder, 'session.jsonl')
      await writeFile(path, await fixture('claude-print'))
      paths.push(path)
    }
    const path = await findClaudeTranscript(configDirs, '/work/example.repo', 0, new Set(paths.slice(0, 3)))
    expect(path).toBe(paths[3])
    expect(await findClaudeTranscript(configDirs, '/work/example.repo', Date.now() + 60_000, new Set())).toBeUndefined()
    expect(await claudeSource(path!).poll()).toMatchObject({ label: 'Review the sample change.', toolUses: 2 })
  })
})
