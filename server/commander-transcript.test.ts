import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { claudeTranscriptItems } from './commander-transcript.js'

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
