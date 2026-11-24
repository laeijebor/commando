import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { relayPrompt } from './agent-host/claude-items.js'
import {
  cleanUserMessageText,
  extractClaudeTranscriptMessages,
  extractCodexRolloutMessages,
  extractCursorTranscriptMessages,
  extractMuseLogMessages,
  extractOpencodeMessages,
} from './chat-message-extractors.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'commando-msg-extract-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('chat-message-extractors', () => {
  it('cleans attachment notes, unwraps relay prompts, and skips harness noise', () => {
    expect(cleanUserMessageText('Fix login bug [Attached image "a.png" is saved at: /tmp/a.png]')).toBe('Fix login bug')
    expect(cleanUserMessageText(relayPrompt('Check the retry backoff', { agentId: 'sub1', label: 'Worker' }))).toBe('Check the retry backoff')
    expect(cleanUserMessageText('<local-command-caveat>ignore</local-command-caveat>')).toBeUndefined()
    expect(cleanUserMessageText('<system-reminder>internal</system-reminder>')).toBeUndefined()
    expect(cleanUserMessageText('<command-name>/clear</command-name>')).toBeUndefined()
    expect(cleanUserMessageText('<command-name>/review</command-name><command-args>PR 42</command-args>')).toBe('/review PR 42')
    expect(cleanUserMessageText('# AGENTS.md\nInstructions')).toBeUndefined()
    expect(cleanUserMessageText('[Commando] "Lobby" (pane %31) looks stalled')).toBeUndefined()
    expect(cleanUserMessageText('[Commando device lock] iPhone 16 is yours')).toBeUndefined()
    expect(cleanUserMessageText('[nudge from Commander] Please check CI')).toBeUndefined()
  })

  it('extracts user messages and timestamps from Claude transcripts while skipping tool results and sidechains', async () => {
    const dir = await makeTempDir()
    const file = join(dir, '11111111-1111-1111-1111-111111111111.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        cwd: '/repo/app',
        gitBranch: 'feat/search',
        timestamp: '2026-11-20T10:00:00.000Z',
        message: { content: 'First prompt about search' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-tool',
        timestamp: '2026-11-20T10:00:05.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'search output' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-meta',
        isMeta: true,
        timestamp: '2026-11-20T10:00:06.000Z',
        message: { content: 'Meta system prompt' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-side',
        isSidechain: true,
        timestamp: '2026-11-20T10:00:07.000Z',
        message: { content: 'Subagent sidechain prompt' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-2',
        timestamp: '2026-11-20T10:05:00.000Z',
        message: { content: [{ type: 'text', text: 'Second prompt refining UI' }] },
      }),
      JSON.stringify({ type: 'summary', customTitle: 'Cmd-K Search' }),
    ]
    await writeFile(file, `${lines.join('\n')}\n`)

    const extracted = await extractClaudeTranscriptMessages(file, 'claude', 1234, '/Users/me/.claudep')
    expect(extracted).toEqual({
      provider: 'claude',
      sessionId: '11111111-1111-1111-1111-111111111111',
      cwd: '/repo/app',
      branch: 'feat/search',
      configDir: '/Users/me/.claudep',
      title: 'Cmd-K Search',
      messages: [
        { messageId: 'u-1', text: 'First prompt about search', sentAt: Date.parse('2026-11-20T10:00:00.000Z') },
        { messageId: 'u-2', text: 'Second prompt refining UI', sentAt: Date.parse('2026-11-20T10:05:00.000Z') },
      ],
    })
  })

  it('skips sdk-cli one-off Claude transcripts', async () => {
    const dir = await makeTempDir()
    const file = join(dir, '11111111-1111-1111-1111-111111111112.jsonl')
    await writeFile(file, `${JSON.stringify({ entrypoint: 'sdk-cli', type: 'user', message: { content: 'hello' } })}\n`)
    expect(await extractClaudeTranscriptMessages(file, 'claude', 1000)).toBeNull()
  })

  it('extracts Codex user messages and skips codex_exec rollouts', async () => {
    const dir = await makeTempDir()
    const execFile = join(dir, 'rollout-exec.jsonl')
    await writeFile(execFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: '22222222-2222-2222-2222-222222222221', cwd: '/repo', originator: 'codex_exec' },
    })}\n`)
    expect(await extractCodexRolloutMessages(execFile, 1000)).toBeNull()

    const chatFile = join(dir, 'rollout-chat.jsonl')
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: '22222222-2222-2222-2222-222222222222', cwd: '/repo/app', git: { branch: 'main' } },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-21T08:00:00.000Z',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Audit SQL queries' }] } },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-21T08:00:01.000Z',
        payload: { type: 'user_message', message: 'Audit SQL queries' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-21T08:10:00.000Z',
        payload: { type: 'user_message', message: 'Add index on sent_at' },
      }),
    ]
    await writeFile(chatFile, `${lines.join('\n')}\n`)

    const extracted = await extractCodexRolloutMessages(
      chatFile,
      1000,
      new Map([['22222222-2222-2222-2222-222222222222', 'SQL audit']]),
    )
    expect(extracted).toEqual({
      provider: 'codex',
      sessionId: '22222222-2222-2222-2222-222222222222',
      cwd: '/repo/app',
      branch: 'main',
      title: 'SQL audit',
      messages: [
        { messageId: 'codex-item-0', text: 'Audit SQL queries', sentAt: Date.parse('2026-11-21T08:00:00.000Z') },
        { messageId: 'codex-ev-1', text: 'Add index on sent_at', sentAt: Date.parse('2026-11-21T08:10:00.000Z') },
      ],
    })
  })

  it('extracts Cursor CLI transcript prompts with user_query tags', async () => {
    const dir = await makeTempDir()
    const file = join(dir, '33333333-3333-3333-3333-333333333333.jsonl')
    const lines = [
      JSON.stringify({ role: 'user', message: { content: '<user_query>\nCheck CSS grid alignment\n</user_query>' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'Sure' } }),
      JSON.stringify({ role: 'user', message: { content: '<user_query>Tighten vertical padding</user_query>' } }),
    ]
    await writeFile(file, `${lines.join('\n')}\n`)

    const extracted = await extractCursorTranscriptMessages(file, '/repo/ui', 5000)
    expect(extracted).toEqual({
      provider: 'cursor',
      sessionId: '33333333-3333-3333-3333-333333333333',
      cwd: '/repo/ui',
      title: 'Check CSS grid alignment',
      messages: [
        { messageId: 'cursor-0', text: 'Check CSS grid alignment', sentAt: 4999 },
        { messageId: 'cursor-1', text: 'Tighten vertical padding', sentAt: 5000 },
      ],
    })
  })

  it('extracts Muse user intents with microsecond timestamps converted to ms', async () => {
    const dir = await makeTempDir()
    const logPath = join(dir, 'session.jsonl')
    const lines = [
      JSON.stringify({
        id: 'evt-1',
        payload_type: 'runtime.user_intent.accepted',
        recorded_at: 1792654409322000,
        payload: {
          semantic_kind: { kind: 'chat' },
          refill_blocks: [{ kind: 'text', text: 'Inspect memory leak' }],
        },
      }),
      JSON.stringify({
        id: 'evt-2',
        payload_type: 'runtime.user_intent.accepted',
        recorded_at: 1792654410000000,
        payload: {
          semantic_kind: { kind: 'reminder' },
          refill_blocks: [{ kind: 'text', text: 'Internal reminder' }],
        },
      }),
    ]
    await writeFile(logPath, `${lines.join('\n')}\n`)

    const extracted = await extractMuseLogMessages({
      sessionId: '44444444-4444-4444-4444-444444444444',
      logPath,
      cwd: '/repo/muse',
      title: 'Memory investigation',
      branch: 'perf',
      updatedAt: 9999,
    })
    expect(extracted).toEqual({
      provider: 'muse',
      sessionId: '44444444-4444-4444-4444-444444444444',
      cwd: '/repo/muse',
      branch: 'perf',
      title: 'Memory investigation',
      messages: [
        { messageId: 'evt-1', text: 'Inspect memory leak', sentAt: 1792654409322 },
      ],
    })
  })

  it('extracts OpenCode user messages from SQLite', async () => {
    const dir = await makeTempDir()
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, NULL)').run('ses_abc12345', '/repo/oc', 'OpenCode chat', 2000)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses_abc12345', 1500, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 'ses_abc12345', 1500, JSON.stringify({ type: 'text', text: 'Migrate router config' }))
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'ses_abc12345', 1600, JSON.stringify({ role: 'assistant' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', 'm2', 'ses_abc12345', 1600, JSON.stringify({ type: 'text', text: 'Done migrating router config' }))
    db.close()

    const extracted = extractOpencodeMessages(dbPath)
    expect(extracted).toEqual([{
      provider: 'opencode',
      sessionId: 'ses_abc12345',
      cwd: '/repo/oc',
      title: 'OpenCode chat',
      messages: [
        { messageId: 'm1', text: 'Migrate router config', sentAt: 1500 },
      ],
    }])
  })
})
