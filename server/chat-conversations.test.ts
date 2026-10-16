import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatConversationIndex } from './chat-conversations.js'

const CLAUDE_ID = '11111111-2222-3333-4444-555555555555'
const CODEX_ID = '01a136f1-62d8-7cd0-9cc8-e494c027571c'
const lines = (...values: unknown[]) => `${values.map((value) => JSON.stringify(value)).join('\n')}\n`

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'commando-conversations-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function claudeTranscript(name: string, entries: unknown[], at: number, configDir = join(home, '.claudep')): Promise<string> {
  const project = join(configDir, 'projects', '-work-app')
  await mkdir(project, { recursive: true })
  const file = join(project, `${name}.jsonl`)
  await writeFile(file, lines(...entries))
  await utimes(file, at / 1000, at / 1000)
  return file
}

async function codexRollout(id: string, meta: Record<string, unknown>, rest: unknown[], at: number): Promise<void> {
  const day = join(home, '.codex', 'sessions', '2026', '10', '13')
  await mkdir(day, { recursive: true })
  const file = join(day, `rollout-2026-10-13T20-00-00-${id}.jsonl`)
  await writeFile(file, lines({ type: 'session_meta', payload: { id, cwd: '/work/app', originator: 'codex_cli_rs', source: 'cli', ...meta } }, ...rest))
  await utimes(file, at / 1000, at / 1000)
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', cwd: '/work/app', gitBranch: 'feature', entrypoint: 'cli', message: { role: 'user', content }, ...extra })

function index(limit?: number) {
  const resolveRepos = vi.fn(async (paths: readonly string[]) => new Map(paths.map((path) => [path, { root: '/work/app', name: 'app', branch: 'feature', isWorktree: false }])))
  return { index: new ChatConversationIndex({ home, codexHome: join(home, '.codex'), claudeConfigDirs: async () => [join(home, '.claudep')], resolveRepos, ...(limit ? { limit } : {}) }), resolveRepos }
}

describe('ChatConversationIndex', () => {
  it('lists Claude and Codex conversations newest first, with titles, folders and repos', async () => {
    await claudeTranscript(CLAUDE_ID, [
      user('<local-command-caveat>ignored</local-command-caveat>'),
      user('Fix the reconnect bug'),
      { type: 'ai-title', aiTitle: 'Reconnect fix' },
      { type: 'ai-title', aiTitle: 'Reconnect fix and tests' },
    ], 2_000_000)
    await codexRollout(CODEX_ID, {}, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Tidy the <image name=[Image #1] path="/x/1.png">\n</image> flags' } }], 3_000_000)
    const { index: conversations } = index()
    expect(await conversations.list()).toEqual([
      { provider: 'codex', sessionId: CODEX_ID, cwd: '/work/app', title: 'Tidy the flags', updatedAt: 3_000_000, repoRoot: '/work/app', checkoutRoot: '/work/app' },
      { provider: 'claude', sessionId: CLAUDE_ID, cwd: '/work/app', title: 'Reconnect fix and tests', updatedAt: 2_000_000, branch: 'feature', configDir: join(home, '.claudep'), repoRoot: '/work/app', checkoutRoot: '/work/app' },
    ])
  })

  it('prefers a name the person gave over Claude\'s title, and uses Codex thread names', async () => {
    await claudeTranscript(CLAUDE_ID, [user('First prompt'), { type: 'custom-title', customTitle: 'My name' }, { type: 'ai-title', aiTitle: 'Later AI title' }], 2_000_000)
    await codexRollout(CODEX_ID, {}, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Prompt' } }], 1_000_000)
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'session_index.jsonl'), lines({ id: CODEX_ID, thread_name: 'Named thread' }))
    const titles = (await index().index.list()).map((conversation) => conversation.title)
    expect(titles).toEqual(['My name', 'Named thread'])
  })

  it.each([false, true])('reads an image prompt beyond the head slice (with preamble: %s)', async (preamble) => {
    const imagePrompt = user([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(300 * 1024).toString('base64') } },
      { type: 'text', text: 'Fix the screenshot layout' },
    ])
    expect(Buffer.byteLength(lines(imagePrompt))).toBeGreaterThan(256 * 1024)
    await claudeTranscript(CLAUDE_ID, [
      ...(preamble ? [user('<local-command-caveat>画像 ignored</local-command-caveat>')] : []),
      imagePrompt,
    ], 1_000)
    const { index: conversations } = index()
    expect(await conversations.list()).toMatchObject([{ title: 'Fix the screenshot layout', cwd: '/work/app' }])
    expect(await conversations.list()).toMatchObject([{ title: 'Fix the screenshot layout' }])
  })

  it('continues looking for cwd when the prompt is already in the head', async () => {
    await claudeTranscript(CLAUDE_ID, [
      { type: 'user', message: { content: 'Keep the first prompt' } },
      { type: 'assistant', cwd: '/work/app', message: { content: 'x'.repeat(300 * 1024) } },
      user('Later prompt'),
    ], 1_000)
    expect(await index().index.list()).toMatchObject([{ title: 'Keep the first prompt', cwd: '/work/app' }])
  })

  it('keeps the tail title lookup after extending the head scan', async () => {
    await claudeTranscript(CLAUDE_ID, [
      user([{ type: 'image', source: { data: 'A'.repeat(600 * 1024) } }, { type: 'text', text: 'First prompt' }]),
      { type: 'custom-title', customTitle: 'Screenshot fix' },
      { type: 'ai-title', aiTitle: 'Later AI title' },
    ], 1_000)
    expect(await index().index.list()).toMatchObject([{ title: 'Screenshot fix' }])
  })

  it('stops looking for a prompt at the hard byte budget', async () => {
    await claudeTranscript(CLAUDE_ID, [
      { type: 'assistant', cwd: '/work/app', message: { content: 'x'.repeat(16 * 1024 * 1024) } },
      user('Beyond the budget'),
    ], 1_000)
    expect(await index().index.list()).toEqual([])
  })

  it.each([
    ['<command-message>sic</command-message>\n<command-name>/sic</command-name>\n<command-args>  Now do X  </command-args>', '/sic Now do X'],
    ['<command-name>/sic</command-name>\n<command-args> </command-args>', '/sic'],
    ['<command-name>/compact</command-name>\n<command-args>Keep the API changes</command-args>', '/compact Keep the API changes'],
  ])('uses a slash-command opener as typed text: %s', async (content, title) => {
    await claudeTranscript(CLAUDE_ID, [user(content)], 1_000)
    expect(await index().index.list()).toMatchObject([{ title }])
  })

  it.each(['clear', 'compact', 'resume', 'help', 'status', 'context', 'cost', 'exit', 'quit'])('skips /%s without arguments and keeps looking for a real prompt', async (command) => {
    await claudeTranscript(CLAUDE_ID, [user(`<command-name>/${command}</command-name>\n<command-args> </command-args>`), user('Real prompt')], 1_000)
    expect(await index().index.list()).toMatchObject([{ title: 'Real prompt' }])
  })

  it.each(['customTitle', 'aiTitle', 'summary'])('lists a conversation with %s even without a typed prompt', async (key) => {
    await claudeTranscript(CLAUDE_ID, [
      user('<local-command-stdout>ignored</local-command-stdout>'),
      { type: 'assistant', message: { content: 'x'.repeat(600 * 1024) } },
      { [key]: 'Saved title' },
    ], 1_000)
    expect(await index().index.list()).toMatchObject([{ title: 'Saved title', cwd: '/work/app' }])
  })

  it('still excludes jobs, injected content, meta and sidechain prompts, invalid ids and empty files', async () => {
    await claudeTranscript(CLAUDE_ID, [user('Run once', { entrypoint: 'sdk-cli' }), { aiTitle: 'Job title' }], 1_000)
    await claudeTranscript('22222222-2222-3333-4444-555555555555', [
      user('<hook-output>ignored</hook-output>'),
      user('<local-command-caveat>ignored</local-command-caveat>'),
      user('<local-command-stdout>ignored</local-command-stdout>'),
      user('Base directory for this skill: /skills/test'),
      user('# AGENTS.md instructions'),
      user('Meta prompt', { isMeta: true }),
      user('Sidechain prompt', { isSidechain: true }),
    ], 1_000)
    await claudeTranscript('invalid_session', [user('Invalid')], 1_000)
    const empty = await claudeTranscript('33333333-2222-3333-4444-555555555555', [], 1_000)
    await writeFile(empty, '')
    expect(await index().index.list()).toEqual([])
  })

  it('still excludes sdk-cli jobs discovered beyond the head slice', async () => {
    await claudeTranscript(CLAUDE_ID, [
      user([{ type: 'image', source: { data: 'A'.repeat(300 * 1024) } }, { type: 'text', text: 'Run once' }], { entrypoint: 'sdk-cli' }),
      { aiTitle: 'Job title' },
    ], 1_000)
    expect(await index().index.list()).toEqual([])
  })

  it('still requires a cwd even when there is a title', async () => {
    await claudeTranscript(CLAUDE_ID, [{ aiTitle: 'Missing folder' }], 1_000)
    expect(await index().index.list()).toEqual([])
  })

  it('defaults to the newest 1000 conversations', async () => {
    await Promise.all(Array.from({ length: 1001 }, (_, number) => claudeTranscript(
      `${String(number).padStart(8, '0')}-2222-3333-4444-555555555555`, [user(`Prompt ${number}`)], (number + 1) * 1_000,
    )))
    const conversations = await index().index.list()
    expect(conversations).toHaveLength(1000)
    expect(conversations[0]?.title).toBe('Prompt 1000')
    expect(conversations.at(-1)?.title).toBe('Prompt 1')
  })

  it('leaves out one-off jobs, subagent threads and transcripts without a typed prompt', async () => {
    await claudeTranscript(CLAUDE_ID, [user('Run once', { entrypoint: 'sdk-cli' })], 1_000)
    await claudeTranscript('22222222-2222-3333-4444-555555555555', [user('<command-name>/clear</command-name>')], 1_000)
    await codexRollout(CODEX_ID, { originator: 'codex_exec', source: 'exec' }, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Job' } }], 1_000)
    await codexRollout('01a136f1-0000-7cd0-9cc8-e494c027571c', { source: { subagent: {} } }, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Sub' } }], 1_000)
    expect(await index().index.list()).toEqual([])
  })

  it('stops at the limit, parses a transcript again once it changes, and finds only listed ones', async () => {
    await claudeTranscript(CLAUDE_ID, [user('Older')], 1_000_000)
    const newer = await claudeTranscript('22222222-2222-3333-4444-555555555555', [user('Newer')], 2_000_000)
    const { index: conversations } = index(1)
    expect((await conversations.list()).map((conversation) => conversation.title)).toEqual(['Newer'])
    await writeFile(newer, lines(user('Newer'), { type: 'ai-title', aiTitle: 'Renamed' }))
    await utimes(newer, 3_000, 3_000)
    expect((await conversations.list()).map((conversation) => conversation.title)).toEqual(['Renamed'])
    expect(await conversations.find('claude', '22222222-2222-3333-4444-555555555555')).toMatchObject({ title: 'Renamed' })
    // Past the limit, so the picker never offered it.
    expect(await conversations.find('claude', CLAUDE_ID)).toBeUndefined()
  })
})
