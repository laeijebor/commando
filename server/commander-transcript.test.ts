import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { claudeTranscriptFileItems, claudeTranscriptItems, tailJsonLines } from './commander-transcript.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const entry = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ uuid, parentUuid, type, message: type === 'assistant' ? { id: `m-${uuid}`, content } : { content }, ...extra })
const texts = (items: ChatItem[]) => items.flatMap((item) => 'text' in item && (item.kind === 'user_message' || item.kind === 'assistant_message') ? [item.text] : [])

describe('claudeTranscriptItems', () => {
  it('follows the current branch through attachments, skipping rewound, sidechain and meta lines', () => {
    const items = claudeTranscriptItems([
      entry('u1', null, 'user', 'First question'),
      entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'First answer' }]),
      // A rewound attempt that the user abandoned.
      entry('u2', 'a1', 'user', 'Abandoned question'),
      entry('a2', 'u2', 'assistant', [{ type: 'text', text: 'Abandoned answer' }]),
      { uuid: 'att', parentUuid: 'a1', type: 'attachment' },
      entry('meta', 'att', 'user', 'Caveat: local command output', { isMeta: true }),
      entry('u3', 'meta', 'user', 'Second question'),
      entry('side', 'u3', 'assistant', [{ type: 'text', text: 'Subagent work' }], { isSidechain: true }),
      entry('a3', 'u3', 'assistant', [{ type: 'text', text: 'Second answer' }]),
      { type: 'last-prompt' },
    ])
    expect(texts(items)).toEqual(['First question', 'First answer', 'Second question', 'Second answer'])
  })
  it('returns nothing for a transcript without messages', () => {
    expect(claudeTranscriptItems([{ type: 'mode' }, { type: 'permission-mode' }])).toEqual([])
  })
})

describe('claudeTranscriptFileItems', () => {
  it('reads further back when large entries push the prompt out of the first window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commander-tail-')); dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    await writeFile(file, [
      JSON.stringify(entry('u1', null, 'user', 'Summarise the incident')),
      // Claude Code logs whole API requests; one can outweigh the starting window.
      JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(5 * 1024 * 1024) }),
      JSON.stringify(entry('a1', 'u1', 'assistant', [{ type: 'text', text: 'The cache expired early.' }])),
      // A background task's result and an interrupt are logged as user turns but aren't the prompt.
      JSON.stringify(entry('n1', 'a1', 'user', '<task-notification>\n<task-id>b1</task-id>\n</task-notification>')),
      JSON.stringify(entry('i1', 'n1', 'user', [{ type: 'text', text: '[Request interrupted by user]' }])),
    ].join('\n') + '\n')
    const window = await tailJsonLines(file)
    expect(window.whole).toBe(false)
    expect(texts(claudeTranscriptItems(window.lines))).toEqual(['The cache expired early.'])
    expect(texts(await claudeTranscriptFileItems(file))).toEqual(['Summarise the incident', 'The cache expired early.'])
  })
})
