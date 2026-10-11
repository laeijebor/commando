import { describe, expect, it } from 'vitest'
import { attachmentNote, chatImageType, chatImageUrl, hostTakesInput, isChatImageId, parseChatImageRefs, parseChatItem, parseChatSessionInfo, parseChatSettingsChange, parseDaemonMessage, parseHostMessage, selectedModelOption, stripAttachmentNotes, stripAttachmentNotesFromSummary } from './agent-chat.js'

const base = { id: 'a', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1 }

describe('parseChatItem', () => {
  it('copies only known fields and normalises nested request and todo data', () => {
    expect(parseChatItem({ ...base, kind: 'assistant_message', text: 'hi', extra: 'dropped' })).toEqual({ ...base, kind: 'assistant_message', text: 'hi' })
    expect(parseChatItem({
      ...base, kind: 'request', requestId: 'r', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Q',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 7 }, 'junk'], multiSelect: 'yes' }, null],
      answer: { kind: 'question', answers: { 'Which?': 'A' } },
    })).toEqual({
      ...base, kind: 'request', requestId: 'r', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Q',
      questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
      answer: { kind: 'question', answers: { 'Which?': 'A' } },
    })
    expect(parseChatItem({ ...base, kind: 'todo_list', todos: [{ content: 'x', status: 'odd' }, 5] })).toEqual({ ...base, kind: 'todo_list', todos: [{ content: 'x', status: 'pending' }] })
  })

  it('rejects malformed items', () => {
    expect(parseChatItem({ ...base, kind: 'file_change', toolUseId: 'u', toolName: 'Edit', path: 'a', additions: 'many', deletions: 0 })).toBeNull()
    expect(parseChatItem({ ...base, kind: 'mystery' })).toBeNull()
    expect(parseChatItem({ ...base, status: 'weird', kind: 'notice', level: 'info', text: 'x' })).toBeNull()
  })

  it('keeps the newest items of an oversized snapshot instead of refusing it', () => {
    const items = Array.from({ length: 5200 }, (_, index) => ({ ...base, id: `i${index}`, kind: 'notice', level: 'info', text: 'x' }))
    const message = parseHostMessage({ type: 'session_snapshot', session: { paneId: '%1', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1 }, items })
    expect(message?.type === 'session_snapshot' && message.items.length).toBe(5000)
  })
})

const session = { paneId: '%1', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1 }

describe('chat settings', () => {
  it('accepts a picker change with known values only', () => {
    expect(parseChatSettingsChange({ model: 'sonnet', effort: 'high', permissionMode: 'plan', extra: 1 })).toEqual({ model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    expect(parseChatSettingsChange({ model: 'opus[1m]' })).toEqual({ model: 'opus[1m]' })
    expect(parseChatSettingsChange({})).toBeNull()
    expect(parseChatSettingsChange({ model: '$(rm -rf ~)' })).toBeNull()
    expect(parseChatSettingsChange({ model: '--settings' })).toBeNull()
    expect(parseChatSettingsChange({ effort: 'extreme' })).toBeNull()
    expect(parseChatSettingsChange({ permissionMode: 'yolo' })).toBeNull()
  })

  it('parses the configure message from the daemon', () => {
    expect(parseDaemonMessage({ type: 'configure', paneId: '%2', settings: { effort: 'low' }, requestId: 'r1' }))
      .toEqual({ type: 'configure', paneId: '%2', settings: { effort: 'low' }, requestId: 'r1' })
    expect(parseDaemonMessage({ type: 'configure', paneId: '%2', settings: {}, requestId: 'r1' })).toBeNull()
    expect(parseDaemonMessage({ type: 'configure', paneId: 'x', settings: { effort: 'low' }, requestId: 'r1' })).toBeNull()
  })

  it('carries the picker state, model list and context usage on the session', () => {
    expect(parseChatSessionInfo({
      ...session,
      selectedModel: 'sonnet', effort: 'max', bypassAllowed: true,
      models: [
        { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', efforts: ['low', 'bogus', 'high'], supportsAutoMode: true, junk: 1 },
        { value: 'bad value', displayName: 'Bad' },
        { value: 'haiku', displayName: 'Haiku 5.5', efforts: [] },
      ],
      contextUsage: { usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 184_000, autoCompact: true, categories: [{ name: 'Messages', tokens: 54_000 }, { name: 'x', tokens: -1 }] },
    })).toEqual({
      ...session,
      selectedModel: 'sonnet', effort: 'max', bypassAllowed: true,
      models: [
        { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', efforts: ['low', 'high'], supportsAutoMode: true },
        { value: 'haiku', displayName: 'Haiku 5.5' },
      ],
      contextUsage: { usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 184_000, autoCompact: true, categories: [{ name: 'Messages', tokens: 54_000 }] },
    })
  })

  it('refuses a session with an invalid effort or model and drops unusable context usage', () => {
    expect(parseChatSessionInfo({ ...session, effort: 'huge' })).toBeNull()
    expect(parseChatSessionInfo({ ...session, selectedModel: 'a b' })).toBeNull()
    expect(parseChatSessionInfo({ ...session, contextUsage: { usedTokens: 5, maxTokens: 0 } })).toEqual(session)
  })
})

describe('richer input', () => {
  const imageId = `${'a'.repeat(64)}.png`

  it('keeps image refs on user messages and tool results, and drops malformed ones', () => {
    expect(parseChatItem({ ...base, kind: 'user_message', text: 'look', images: [{ id: imageId, name: 'pane.png', extra: 1 }] }))
      .toEqual({ ...base, kind: 'user_message', text: 'look', images: [{ id: imageId, name: 'pane.png' }] })
    expect(parseChatItem({ ...base, kind: 'tool', toolUseId: 'u', toolName: 'Read', title: 'Read a.png', images: [{ id: '../../etc/passwd' }] }))
      .toEqual({ ...base, kind: 'tool', toolUseId: 'u', toolName: 'Read', title: 'Read a.png' })
    expect(parseChatImageRefs([{ id: imageId }], 1)).toEqual([{ id: imageId }])
    expect(parseChatImageRefs([{ id: imageId }, { id: imageId }], 1)).toBeNull()
    expect(parseChatImageRefs([{ id: `${'a'.repeat(64)}.svg` }])).toBeNull()
  })

  it('maps image ids to their type and URL', () => {
    expect(isChatImageId(imageId)).toBe(true)
    expect(isChatImageId(`${'A'.repeat(64)}.png`)).toBe(false)
    expect(chatImageType(`${'b'.repeat(64)}.jpg`)).toBe('image/jpeg')
    expect(chatImageUrl(imageId)).toBe(`/chat-images/${imageId}`)
  })

  it('parses the command list, dropping unusable entries', () => {
    expect(parseHostMessage({
      type: 'commands', paneId: '%1', commands: [
        { name: 'redline', description: 'Review', argumentHint: '<what>', kind: 'skill' },
        { name: 'compact', description: 'Free context', aliases: ['c', 'bad alias'], kind: 'command' },
        { name: 'has space', description: 'x', kind: 'command' },
        { name: 'nokind', description: 'x' },
      ],
    })).toEqual({
      type: 'commands', paneId: '%1', commands: [
        { name: 'redline', description: 'Review', argumentHint: '<what>', kind: 'skill' },
        { name: 'compact', description: 'Free context', aliases: ['c'], kind: 'command' },
      ],
    })
  })

  it('routes file searches and their results', () => {
    expect(parseDaemonMessage({ type: 'file_search', paneId: '%1', query: 'src/ch', requestId: 'r' }))
      .toEqual({ type: 'file_search', paneId: '%1', query: 'src/ch', requestId: 'r' })
    expect(parseDaemonMessage({ type: 'file_search', paneId: '%1', query: 'x'.repeat(600), requestId: 'r' })).toBeNull()
    expect(parseHostMessage({ type: 'file_search_result', paneId: '%1', requestId: 'r', entries: [{ path: 'src/a.ts', kind: 'file' }, { path: '', kind: 'file' }, { path: 'src/', kind: 'directory' }], truncated: true }))
      .toEqual({ type: 'file_search_result', paneId: '%1', requestId: 'r', entries: [{ path: 'src/a.ts', kind: 'file' }, { path: 'src/', kind: 'directory' }], truncated: true })
  })

  it('carries image refs on a send and refuses bad ones', () => {
    expect(parseDaemonMessage({ type: 'send', paneId: '%1', text: '', images: [{ id: imageId }], requestId: 'r' }))
      .toEqual({ type: 'send', paneId: '%1', text: '', images: [{ id: imageId }], requestId: 'r' })
    expect(parseDaemonMessage({ type: 'send', paneId: '%1', text: 'hi', requestId: 'r' })).toEqual({ type: 'send', paneId: '%1', text: 'hi', requestId: 'r' })
    expect(parseDaemonMessage({ type: 'send', paneId: '%1', text: 'hi', images: [{ id: 'x.png' }], requestId: 'r' })).toBeNull()
    expect(parseDaemonMessage({ type: 'send', paneId: '%1', text: 'hi', images: Array.from({ length: 11 }, () => ({ id: imageId })), requestId: 'r' })).toBeNull()
  })

  it('tells hosts that take richer input from older ones', () => {
    expect(hostTakesInput({ hostVersion: 2 })).toBe(false)
    expect(hostTakesInput({ hostVersion: 3 })).toBe(true)
  })
})

describe('selectedModelOption', () => {
  const models = [
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5' },
    { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
    { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
  ]

  it('matches a persisted full id to its alias row', () => {
    expect(selectedModelOption({ models, selectedModel: 'claude-sonnet-5-5' })?.value).toBe('sonnet')
    expect(selectedModelOption({ models, selectedModel: 'claude-opus-5-5' })?.value).toBe('opus')
    expect(selectedModelOption({ models, selectedModel: 'sonnet' })?.value).toBe('sonnet')
  })

  it('falls back to the running model when the pick has no row, and to the default row without a pick', () => {
    expect(selectedModelOption({ models, selectedModel: 'claude-sonnet-5', model: 'claude-sonnet-5-5' })?.value).toBe('sonnet')
    expect(selectedModelOption({ models, selectedModel: 'claude-sonnet-5' })).toBeUndefined()
    expect(selectedModelOption({ models, model: 'claude-opus-5-5' })?.value).toBe('default')
  })

  it('matches a context-window variant to its model’s row', () => {
    expect(selectedModelOption({ models, model: 'claude-opus-5-5[1m]' })?.value).toBe('default')
    expect(selectedModelOption({ models, model: 'claude-sonnet-5-5[1m]' })?.value).toBe('sonnet')
  })

  it('takes the default row before Claude reports a model', () => {
    expect(selectedModelOption({ models })?.value).toBe('default')
    expect(selectedModelOption({ models: [] })).toBeUndefined()
  })
})

describe('attachment notes', () => {
  const note = attachmentNote('shot "1".png', '/state/chat-image-sessions/s1/abc.png')

  it('strips the notes the host appends, leaving what the person typed', () => {
    expect(note).toBe('[Attached image "shot _1_.png" is saved at: /state/chat-image-sessions/s1/abc.png]')
    expect(stripAttachmentNotes(`fix this layout\n\n${note}\n\n${note}`)).toBe('fix this layout')
    expect(stripAttachmentNotes(note)).toBe('')
    expect(stripAttachmentNotes('keep [Attached image] as typed')).toBe('keep [Attached image] as typed')
  })

  it('strips a note a summary cut off at the end too', () => {
    // Hook summaries flatten newlines and stop at a length limit.
    const summary = `fix this layout ${note} ${note}`.slice(0, 140)
    expect(stripAttachmentNotesFromSummary(summary)).toBe('fix this layout')
    expect(stripAttachmentNotesFromSummary(`fix this ${note.slice(0, 20)}`)).toBe('fix this')
    expect(stripAttachmentNotesFromSummary('no notes here')).toBe('no notes here')
  })
})
