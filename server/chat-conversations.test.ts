import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatConversations } from '../shared/chat-conversations.js'
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
  return { index: new ChatConversationIndex({ home, codexHome: join(home, '.codex'), xdgDataHome: join(home, '.local', 'share'), claudeConfigDirs: async () => [join(home, '.claudep')], resolveRepos, ...(limit ? { limit } : {}) }), resolveRepos }
}

const cursorProject = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
async function cursorTranscript(id: string, cwd: string, options: { flat?: boolean; sidecar?: boolean; store?: boolean; at?: number } = {}) {
  const root = join(home, '.cursor')
  const transcripts = join(root, 'projects', cursorProject(cwd), 'agent-transcripts')
  const directory = options.flat ? transcripts : join(transcripts, id)
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${id}.jsonl`)
  await writeFile(file, lines(
    { role: 'assistant', message: { content: [{ type: 'text', text: '<user_query>Not the user</user_query>' }] } },
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>ignored</timestamp>\n<user_query>\nReply with the word ok.\n</user_query>' }] } },
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>Later prompt</user_query>' }] } },
  ))
  await utimes(file, (options.at ?? 1_000_000) / 1000, (options.at ?? 1_000_000) / 1000)
  const chat = join(root, 'chats', createHash('md5').update(cwd).digest('hex'), id)
  await mkdir(chat, { recursive: true })
  if (options.store !== false) await writeFile(join(chat, 'store.db'), 'fixture')
  if (options.sidecar !== false) await writeFile(join(chat, 'meta.json'), JSON.stringify({ cwd }))
  return { file, chat }
}

async function opencodeDb(dataHome = join(home, '.local', 'share')) {
  await mkdir(join(dataHome, 'opencode'), { recursive: true })
  const db = new DatabaseSync(join(dataHome, 'opencode', 'opencode.db'))
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER)')
  return db
}

describe('ChatConversationIndex', () => {
  it.each([false, true])('indexes CLI Cursor transcripts (flat: %s), with exact cwd from the sidecar', async (flat) => {
    const cwd = join(home, 'workspace with spaces-and-dashes')
    await mkdir(cwd)
    const { file } = await cursorTranscript(CLAUDE_ID, cwd, { flat })
    const { index: conversations } = index()
    expect(await conversations.list()).toMatchObject([{ provider: 'cursor', sessionId: CLAUDE_ID, cwd, title: 'Reply with the word ok.', updatedAt: 1_000_000 }])
    expect(await conversations.list()).toMatchObject([{ title: 'Reply with the word ok.' }])
    await writeFile(file, lines({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>${'x'.repeat(220)}</user_query>` }] } }))
    await utimes(file, 2000, 2000)
    expect(await conversations.list()).toMatchObject([{ title: `${'x'.repeat(199)}…`, updatedAt: 2_000_000 }])
  })

  it('resolves lossy Cursor project paths against the filesystem and uses the chat hash to disambiguate', async () => {
    const cwd = join(await realpath(home), 'ambiguous-path', 'with spaces')
    await mkdir(cwd, { recursive: true })
    await mkdir(join(await realpath(home), 'ambiguous', 'path-with-spaces'), { recursive: true })
    expect(cursorProject(cwd)).toBe(cursorProject(join(await realpath(home), 'ambiguous', 'path-with-spaces')))
    await cursorTranscript(CLAUDE_ID, cwd, { sidecar: false })
    expect(await index().index.list()).toMatchObject([{ provider: 'cursor', cwd }])
  })

  it('reads a Cursor first prompt beyond the initial head slice and deduplicates both transcript layouts', async () => {
    const { file } = await cursorTranscript(CLAUDE_ID, home)
    await writeFile(file, lines(
      { role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>First real prompt</user_query>' }] } },
    ))
    await utimes(file, 2000, 2000)
    await cursorTranscript(CLAUDE_ID, home, { flat: true })
    expect(await index().index.list()).toMatchObject([{ provider: 'cursor', title: 'First real prompt', updatedAt: 2_000_000 }])
  })

  it('excludes SDK ids, transcripts without a CLI store, and unresolved Cursor workspaces', async () => {
    await cursorTranscript(`agent-${CLAUDE_ID}`, home)
    await cursorTranscript(CODEX_ID, home, { store: false })
    await cursorTranscript(CLAUDE_ID, join(home, 'missing'), { sidecar: false })
    expect(await index().index.list()).toEqual([])
  })

  it('rejects a Cursor sidecar pointing at a different workspace hash', async () => {
    const { chat } = await cursorTranscript(CLAUDE_ID, join(home, 'missing'))
    await writeFile(join(chat, 'meta.json'), JSON.stringify({ cwd: home }))
    expect(await index().index.list()).toEqual([])
  })

  it('reads only top-level unarchived OpenCode sessions, refreshing rows and sharing the global limit', async () => {
    const db = await opencodeDb()
    const id = 'ses_ed3f6d576ffeGGkSAFgSk4Snvz'
    try {
      const insert = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
      insert.run(id, null, home, 'OpenCode title', 3_000_000, null)
      insert.run('ses_child123', id, home, 'Child', 9_000_000, null)
      insert.run('ses_archived', null, home, 'Archived', 9_000_000, 1)
      insert.run('ses_bad;id', null, home, 'Invalid id', 9_000_000, null)
      await claudeTranscript(CLAUDE_ID, [user('Claude')], 1_000_000)
      await cursorTranscript(CODEX_ID, home, { at: 2_000_000 })
      const { index: conversations } = index(2)
      expect(await conversations.list()).toMatchObject([
        { provider: 'opencode', sessionId: id, cwd: home, title: 'OpenCode title', updatedAt: 3_000_000 },
        { provider: 'cursor', updatedAt: 2_000_000 },
      ])
      db.prepare('UPDATE session SET title = ? WHERE id = ?').run('Renamed', id)
      expect(await conversations.list()).toMatchObject([{ title: 'Renamed' }, { provider: 'cursor' }])
    } finally { db.close() }
  })

  it('honours XDG_DATA_HOME for OpenCode', async () => {
    const dataHome = join(home, 'xdg-data')
    const db = await opencodeDb(dataHome)
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, NULL)').run('ses_session123', home, 'XDG session', 1000)
    db.close()
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    try {
      const conversations = new ChatConversationIndex({ home, codexHome: join(home, '.codex'), resolveRepos: async () => new Map() })
      expect(await conversations.list()).toMatchObject([{ provider: 'opencode', title: 'XDG session' }])
    } finally { vi.unstubAllEnvs() }
  })

  it('shortens long OpenCode titles so the client keeps the conversation', async () => {
    const db = await opencodeDb()
    try {
      db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, NULL)').run('ses_session123', home, 'x'.repeat(600), 1000)
      const conversations = await index().index.list()
      expect(conversations).toMatchObject([{ provider: 'opencode', sessionId: 'ses_session123', title: `${'x'.repeat(199)}…` }])
      expect(parseChatConversations({ conversations })).toEqual(conversations)
    } finally { db.close() }
  })

  it('ignores missing, locked and malformed OpenCode databases', async () => {
    const { index: conversations } = index()
    expect(await conversations.list()).toEqual([])
    const db = await opencodeDb()
    try {
      db.exec("INSERT INTO session VALUES ('ses_session123', NULL, '/work', 'Locked', 1000, NULL); BEGIN EXCLUSIVE")
      expect(await conversations.list()).toEqual([])
      db.exec('ROLLBACK')
      expect(await conversations.list()).toMatchObject([{ title: 'Locked' }])
    } finally { db.close() }
    await writeFile(join(home, '.local', 'share', 'opencode', 'opencode.db'), 'not sqlite')
    expect(await conversations.list()).toEqual([])
  })

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

type CursorRow = {
  agent_id: string | null
  workspace_ref: string | null
  name: string | null
  updated_at: string | null
}
const CURSOR_ID = 'agent-11111111-2222-3333-4444-555555555555'
const OTHER_CURSOR_ID = 'agent-22222222-2222-3333-4444-555555555555'
const cursorRow = (overrides: Partial<CursorRow> = {}): CursorRow => ({
  agent_id: CURSOR_ID, workspace_ref: '/work/app', name: 'Cursor work', updated_at: new Date(3_000_000).toISOString(), ...overrides,
})

async function cursorStore(project: string, hash: string, rows: CursorRow[], at: number): Promise<string> {
  const file = join(home, '.cursor', 'projects', project, 'sdk-agent-store', hash, 'index.db')
  await mkdir(dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  try {
    database.exec('create table agents (agent_id TEXT, workspace_ref TEXT, status TEXT, name TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT)')
    const insert = database.prepare('insert into agents values (?, ?, ?, ?, ?, ?, ?)')
    for (const row of rows) insert.run(row.agent_id, row.workspace_ref, 'idle', row.name, '{}', row.updated_at, row.updated_at)
  } finally {
    database.close()
  }
  await utimes(file, at / 1000, at / 1000)
  return file
}

describe('Cursor SQLite conversation stores', () => {
  it('lists conversations from multiple workspaces and store hashes beside Claude and Codex transcripts', async () => {
    await claudeTranscript(CLAUDE_ID, [user('Claude work')], 2_000_000)
    await codexRollout(CODEX_ID, {}, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Codex work' } }], 1_500_000)
    await cursorStore('-work-app', 'hash-a', [cursorRow()], 4_000_000)
    await cursorStore('-work-app-worktrees-feature', 'hash-b', [cursorRow({ agent_id: OTHER_CURSOR_ID, workspace_ref: '/work/app-worktrees/feature', name: 'Worktree chat', updated_at: new Date(1_000_000).toISOString() })], 3_000_000)
    await cursorStore('-work-app', 'hash-c', [cursorRow({ agent_id: 'agent-another-hash', name: 'Another store', updated_at: new Date(500_000).toISOString() })], 2_000_000)
    const { index: conversations, resolveRepos } = index()
    const found = await conversations.list()
    expect(found.map((entry) => entry.title)).toEqual(['Cursor work', 'Claude work', 'Codex work', 'Worktree chat', 'Another store'])
    expect(found[0]).toEqual({ provider: 'cursor', sessionId: CURSOR_ID, cwd: '/work/app', title: 'Cursor work', updatedAt: 3_000_000, repoRoot: '/work/app', checkoutRoot: '/work/app' })
    expect(found[3]).toMatchObject({ provider: 'cursor', sessionId: OTHER_CURSOR_ID, cwd: '/work/app-worktrees/feature' })
    expect(resolveRepos).toHaveBeenCalledWith(['/work/app', '/work/app-worktrees/feature'])
    expect(await conversations.find('cursor', OTHER_CURSOR_ID)).toEqual(found[3])
  })

  it('uses the newest rows within each database and keeps the overall conversation limit', async () => {
    await cursorStore('-work-app', 'hash-a', [
      cursorRow({ updated_at: new Date(1_000_000).toISOString() }),
      cursorRow({ agent_id: OTHER_CURSOR_ID, name: 'Newest Cursor', updated_at: new Date(3_000_000).toISOString() }),
    ], 1_000_000)
    await claudeTranscript(CLAUDE_ID, [user('Older Claude')], 2_000_000)
    expect((await index(1).index.list()).map((entry) => entry.title)).toEqual(['Newest Cursor'])
  })

  it('returns an empty list when the Cursor projects directory does not exist', async () => {
    expect(await index().index.list()).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  it('skips corrupt databases, incompatible schemas and malformed rows without hiding valid conversations', async () => {
    const corrupt = await cursorStore('-work-app', 'corrupt', [], 5_000_000)
    await writeFile(corrupt, 'not a SQLite database')
    const incompatible = await cursorStore('-work-app', 'incompatible', [], 4_000_000)
    const database = new DatabaseSync(incompatible)
    try { database.exec('drop table agents') } finally { database.close() }
    await cursorStore('-work-app', 'valid', [
      cursorRow({ agent_id: null }),
      cursorRow({ agent_id: 'bad id!' }),
      cursorRow({ workspace_ref: null }),
      cursorRow({ workspace_ref: 'relative/path' }),
      cursorRow({ workspace_ref: '/work/\0app' }),
      cursorRow({ updated_at: null }),
      cursorRow({ updated_at: 'not a date' }),
      cursorRow(),
    ], 3_000_000)
    await claudeTranscript(CLAUDE_ID, [user('Still here')], 1_000_000)
    expect((await index().index.list()).map((entry) => entry.title)).toEqual(['Cursor work', 'Still here'])
  })

  it('treats New Agent and empty names as untitled, falling back to the conversation id', async () => {
    await cursorStore('-work-app', 'hash-a', [
      cursorRow({ name: ' New Agent ' }),
      cursorRow({ agent_id: OTHER_CURSOR_ID, name: '  ' }),
      cursorRow({ agent_id: 'agent-without-name', name: null }),
      cursorRow({ agent_id: 'agent-named-chat', name: '  A named\nchat  ' }),
    ], 1_000_000)
    const titles = new Map((await index().index.list()).map((entry) => [entry.sessionId, entry.title]))
    expect(titles.get(CURSOR_ID)).toBe(CURSOR_ID)
    expect(titles.get(OTHER_CURSOR_ID)).toBe(OTHER_CURSOR_ID)
    expect(titles.get('agent-without-name')).toBe('agent-without-name')
    expect(titles.get('agent-named-chat')).toBe('A named chat')
  })

  it('chooses the latest conversation row when multiple stores contain the same agent', async () => {
    await cursorStore('-work-app', 'newer-file', [cursorRow({ name: 'Older row', updated_at: new Date(1_000_000).toISOString() })], 3_000_000)
    await cursorStore('-work-app', 'older-file', [cursorRow({ name: 'Newest row' })], 2_000_000)
    const found = await index().index.list()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sessionId: CURSOR_ID, title: 'Newest row', updatedAt: 3_000_000 })
  })

  it('opens existing stores read-only without rewriting the database or adding sidecar files', async () => {
    const file = await cursorStore('-work-app', 'hash-a', [cursorRow()], 1_000_000)
    const before = await readFile(file)
    expect(await index().index.list()).toHaveLength(1)
    expect(await readFile(file)).toEqual(before)
    expect(await readdir(dirname(file))).toEqual(['index.db'])
  })

  it('reads only the 200 most recently modified database files', async () => {
    // An older file with a newer conversation is deliberately outside the scan budget.
    await cursorStore('-work-app', '000-oldest', [cursorRow({ agent_id: OTHER_CURSOR_ID, name: 'Outside budget', updated_at: new Date(9_000_000).toISOString() })], 1_000)
    const seed = await cursorStore('-work-app', 'store-0', [cursorRow()], 10_000)
    const bytes = await readFile(seed)
    await Promise.all(Array.from({ length: 199 }, async (_, i) => {
      const file = join(dirname(dirname(seed)), `store-${i + 1}`, 'index.db')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
      await utimes(file, (10_001 + i) / 1000, (10_001 + i) / 1000)
    }))
    expect((await index().index.list()).map((entry) => entry.title)).toEqual(['Cursor work'])
  })
})
