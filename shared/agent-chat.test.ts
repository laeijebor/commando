import { describe, expect, it } from 'vitest'
import { findChatReplyEmbed, takeQueueBatch, parseChatQueueAction, attachmentNote, chatImageContentType, hostTakesVideos, isChatAttachmentId, isChatVideoId, notedVideos, chatImageStillId, chatImageType, chatImageUrl, hostTakesInput, isChatImageId, parseChatImageRefs, parseChatItem, parseChatSessionInfo, parseChatSettingsChange, parseDaemonMessage, parseHostMessage, selectedModelOption, stripAttachmentNotes, stripAttachmentNotesFromSummary } from './agent-chat.js'

const base = { id: 'a', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1 }

describe('parseChatItem', () => {
  it('keeps the images a reply shows, and drops ones that do not parse', () => {
    const svg = `${'a'.repeat(64)}.svg`
    expect(parseChatItem({ ...base, kind: 'assistant_message', text: '![d](d.svg)', images: [
      { src: 'd.svg', id: svg },
      { src: 'gone.png', error: 'missing' },
      { src: 'bad.png', id: '../secret' },
      { src: 'odd.png', error: 'exploded' },
      { id: svg },
    ] })).toEqual({ ...base, kind: 'assistant_message', text: '![d](d.svg)', images: [{ src: 'd.svg', id: svg }, { src: 'gone.png', error: 'missing' }] })
    expect(parseChatItem({ ...base, kind: 'assistant_message', text: 'x', images: [{ src: 'bad.png', id: 'nope' }] })).toEqual({ ...base, kind: 'assistant_message', text: 'x' })
  })

  it('names an SVG reply image and the PNG drawn from it', () => {
    const svg = `${'a'.repeat(64)}.svg`
    expect(chatImageStillId(svg)).toBe(`${svg}.png`)
    expect(chatImageStillId(`${'a'.repeat(64)}.jpg`)).toBe(`${'a'.repeat(64)}.jpg`)
    expect(chatImageContentType(svg)).toBe('image/svg+xml')
    expect(chatImageContentType(`${svg}.png`)).toBe('image/png')
    expect(chatImageContentType(`${'a'.repeat(64)}.webp`)).toBe('image/webp')
    // Attachments, which reach Claude, never take SVG.
    expect(isChatImageId(svg)).toBe(false)
  })

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

  it('keeps an approval reason and only a true noAlwaysAllow', () => {
    const request = { ...base, kind: 'request', requestId: 'r', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?' }
    expect(parseChatItem({ ...request, reason: 'Safety check: rm', noAlwaysAllow: true })).toEqual({ ...request, reason: 'Safety check: rm', noAlwaysAllow: true })
    expect(parseChatItem({ ...request, reason: 5, noAlwaysAllow: 'yes' })).toEqual(request)
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

describe('chat providers', () => {
  it('preserves optional handoff providers without changing legacy messages or version gates', () => {
    const legacy = { type: 'handoff', paneId: '%1', sessionId: 'thread-123', cwd: '/w', queue: [], returnFlags: [] }
    expect(parseHostMessage(legacy)).toEqual(legacy)
    expect(parseHostMessage({ ...legacy, provider: 'codex' })).toEqual({ ...legacy, provider: 'codex' })
    expect(parseHostMessage({ ...legacy, provider: 'cursor' })).toEqual({ ...legacy, provider: 'cursor' })
    expect(parseHostMessage({ ...legacy, provider: 'claude' })).toEqual({ ...legacy, provider: 'claude' })
    expect(parseHostMessage({ ...legacy, provider: 'other' })).toBeNull()
  })

  it('keeps whether a Muse host runs without its sandbox, and nothing else in its place', () => {
    const info = { ...session, provider: 'muse', sandboxed: false }
    expect(parseChatSessionInfo(info)).toEqual(info)
    expect(parseChatSessionInfo({ ...info, sandboxed: 'no' })).toEqual({ ...session, provider: 'muse' })
  })

  it.each(['claude', 'codex', 'cursor'])('keeps %s on sessions, snapshots and updates', (provider) => {
    const info = { ...session, provider }
    expect(parseChatSessionInfo({ ...info, extra: 'dropped' })).toEqual(info)
    expect(parseHostMessage({ type: 'session_snapshot', session: info, items: [] }))
      .toEqual({ type: 'session_snapshot', session: info, items: [] })
    expect(parseHostMessage({ type: 'session_update', session: info }))
      .toEqual({ type: 'session_update', session: info })
  })

  it.each(['other', '', undefined, 7])('rejects unknown provider %s', (provider) => {
    const info = { ...session, provider }
    expect(parseChatSessionInfo(info)).toBeNull()
    expect(parseHostMessage({ type: 'session_snapshot', session: info, items: [] })).toBeNull()
    expect(parseHostMessage({ type: 'session_update', session: info })).toBeNull()
  })
})

describe('chat settings', () => {
  it('accepts a picker change with known values only', () => {
    expect(parseChatSettingsChange({ model: 'sonnet', effort: 'high', permissionMode: 'plan', extra: 1 })).toEqual({ model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    expect(parseChatSettingsChange({ model: 'opus[1m]' })).toEqual({ model: 'opus[1m]' })
    expect(parseChatSettingsChange({})).toBeNull()
    expect(parseChatSettingsChange({ model: '$(rm -rf ~)' })).toBeNull()
    expect(parseChatSettingsChange({ model: '--settings' })).toBeNull()
    expect(parseChatSettingsChange({ effort: 'extreme' })).toBeNull()
    expect(parseChatSettingsChange({ permissionMode: 'yolo' })).toBeNull()
    expect(parseChatSettingsChange({ fast: false })).toEqual({ fast: false })
    expect(parseChatSettingsChange({ fast: 'yes' })).toBeNull()
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
    for (const length of [1, 5, 14, 17]) expect(stripAttachmentNotesFromSummary(`fix this ${note.slice(0, length)}`)).toBe('fix this')
    expect(stripAttachmentNotesFromSummary(note.slice(0, 60))).toBe('')
    const bracketed = attachmentNote('my [draft].png', '/state/chat-image-sessions/s1/abc.png')
    expect(stripAttachmentNotesFromSummary(`fix this ${bracketed.slice(0, 30)}`)).toBe('fix this')
    // Brackets the person typed stay.
    expect(stripAttachmentNotesFromSummary('see list[0] and [docs]')).toBe('see list[0] and [docs]')
    expect(stripAttachmentNotesFromSummary('arr[A')).toBe('arr[A')
    expect(stripAttachmentNotesFromSummary('no notes here')).toBe('no notes here')
  })

  it('names attached videos, which the person typing never sees', () => {
    const id = `${'b'.repeat(64)}.mov`
    const video = attachmentNote('Screen Recording.mov', `/state/chat-image-sessions/s1/${id}`, 'video')
    expect(video).toBe(`[Attached video "Screen Recording.mov" is saved at: /state/chat-image-sessions/s1/${id}]`)
    expect(stripAttachmentNotes(`what happens here?\n\n${video}\n\n${note}`)).toBe('what happens here?')
    expect(stripAttachmentNotesFromSummary(`what happens here? ${video.slice(0, 25)}`)).toBe('what happens here?')
    expect(notedVideos(`look\n\n${video}\n\n${note}`)).toEqual([{ id, name: 'Screen Recording.mov' }])
    // Only a saved copy's name is an id; a typed note naming anything else is text.
    expect(notedVideos('[Attached video "x" is saved at: /tmp/other.mov]')).toEqual([])
  })
})

describe('attached videos', () => {
  const id = `${'c'.repeat(64)}.mp4`

  it('are refs with a video id, which only newer hosts take', () => {
    expect(isChatVideoId(id)).toBe(true)
    expect(isChatImageId(id)).toBe(false)
    expect(isChatAttachmentId(id) && isChatAttachmentId(`${'c'.repeat(64)}.png`)).toBe(true)
    expect(isChatVideoId(`${'c'.repeat(64)}.mkv`)).toBe(false)
    expect(parseChatImageRefs([{ id, name: 'clip.mp4' }])).toEqual([{ id, name: 'clip.mp4' }])
    expect(chatImageContentType(id)).toBe('video/mp4')
    expect(chatImageContentType(`${'c'.repeat(64)}.mov`)).toBe('video/quicktime')
    expect(hostTakesVideos({ hostVersion: 6 })).toBe(false)
    expect(hostTakesVideos({ hostVersion: 7 })).toBe(true)
  })
})

describe('chat login', () => {
  it.each(['required', 'pending'])('keeps validated login state %s', (state) => {
    const login = { state, reason: 'Sign in', url: 'https://cursor.com/login' }
    expect(parseChatSessionInfo({ ...session, provider: 'cursor', login })?.login).toEqual(login)
  })
  it.each([null, {}, { state: 'logged-in' }, { state: 1 }])('drops malformed login %j', (login) => {
    expect(parseChatSessionInfo({ ...session, login })?.login).toBeUndefined()
  })
  it.each(['http://cursor.com', 'javascript:alert(1)', 'not a url', `https://cursor.com/${'a'.repeat(2048)}`])('drops unsafe or oversized login URLs', (url) => {
    expect(parseChatSessionInfo({ ...session, login: { state: 'pending', url } })?.login).toEqual({ state: 'pending' })
  })
  it('bounds the reason and drops nonstring optional fields', () => {
    expect(parseChatSessionInfo({ ...session, login: { state: 'required', reason: 'x'.repeat(1000) } })?.login?.reason).toHaveLength(500)
    expect(parseChatSessionInfo({ ...session, login: { state: 'required', reason: {}, url: 7 } })?.login).toEqual({ state: 'required' })
  })
})

describe('steering the whole queue', () => {
  it('parses steer_all without an id, and batches queued messages up to the image limit', () => {
    expect(parseChatQueueAction({ action: 'steer_all' })).toEqual({ action: 'steer_all' })
    expect(parseDaemonMessage({ type: 'queue', paneId: '%1', requestId: 'r1', action: 'steer_all' })).toEqual({ type: 'queue', paneId: '%1', requestId: 'r1', action: 'steer_all' })
    const image = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${String(i).padStart(64, 'a')}.png`, name: 'a.png' }))
    const queue = [{ id: 'a', text: 'one', images: image(6) }, { id: 'b', text: 'two' }, { id: 'c', text: 'three', images: image(6) }]
    expect(takeQueueBatch(queue)).toEqual({ batch: queue.slice(0, 2), rest: queue.slice(2) })
    const big = [{ id: 'a', text: 'huge', images: image(12) }, { id: 'b', text: 'next' }]
    expect(takeQueueBatch(big).batch.map((queued) => queued.id)).toEqual(['a'])
    expect(takeQueueBatch([])).toEqual({ batch: [], rest: [] })
  })
})

it('validates reply resources, drops malformed entries, and preserves only known metadata', () => {
  const file = { ref: 'README.md:7', path: '/work/README.md', kind: 'file', size: 123, mtimeMs: 1000, line: 7 }
  const folder = { ref: './src', path: '/work/src', kind: 'folder', entries: 9999 }
  const missing = { ref: './missing', path: '/work/missing', missing: true }
  const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'files', resources: [
    { ...file, secret: 'drop' }, folder, missing,
    { ...file, path: 'relative' }, { ...file, size: -1 }, { ...file, mtimeMs: Infinity },
    { ...folder, entries: 10000 }, { ...file, line: 0 }, { ...file, line: 1.2 },
    { ...file, kind: 'device' }, { ...file, ref: '' }, { ...file, path: '/bad\u0000path' },
  ] })
  expect(parsed).toEqual({ ...base, kind: 'assistant_message', text: 'files', resources: [file, folder, missing] })
  const capped = parseChatItem({ ...base, kind: 'assistant_message', text: 'files', resources: Array(60).fill(file) })
  expect(capped?.kind === 'assistant_message' && capped.resources?.length).toBe(50)
  expect(parseChatItem({ ...base, kind: 'assistant_message', text: 'files', resources: [{ path: '/bad' }] })).not.toHaveProperty('resources')
})

it('keeps the path of a stored reply image only when it is a clean absolute path', () => {
  const id = `${'b'.repeat(64)}.svg`
  const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', images: [
    { src: 'a.svg', id, path: '/work/a.svg' }, { src: 'b.svg', id, path: 'relative.svg' }, { src: 'c.svg', id, path: '/bad\u0007.svg' },
  ] })
  expect(parsed).toEqual({ ...base, kind: 'assistant_message', text: 'x', images: [{ src: 'a.svg', id, path: '/work/a.svg' }, { src: 'b.svg', id }, { src: 'c.svg', id }] })
})

it('validates rendered pr-diagram fences and drops malformed ones', () => {
  const hash = 'c'.repeat(64)
  const id = `${'d'.repeat(64)}.svg`
  const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', diagrams: [
    { hash, id, extra: 'drop' },
    { hash, error: 'invalid', message: 'title: is required' },
    { hash, error: 'renderer_missing', message: '   ' },
    { hash, id: `${'d'.repeat(64)}.png` },
    { hash: 'short', id },
    { hash, error: 'exploded' },
    { hash, id: '../etc/passwd.svg' },
  ] })
  expect(parsed).toEqual({ ...base, kind: 'assistant_message', text: 'x', diagrams: [
    { hash, id }, { hash, error: 'invalid', message: 'title: is required' }, { hash, error: 'renderer_missing' },
  ] })
  const long = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', diagrams: [{ hash, error: 'invalid', message: 'x'.repeat(5000) }] })
  expect(long?.kind === 'assistant_message' && long.diagrams?.[0]).toMatchObject({ message: 'x'.repeat(2000) })
  const capped = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', diagrams: Array(20).fill({ hash, id }) })
  expect(capped?.kind === 'assistant_message' && capped.diagrams?.length).toBe(10)
  expect(parseChatItem({ ...base, kind: 'assistant_message', text: 'x', diagrams: 'nope' })).not.toHaveProperty('diagrams')
})

describe('reply embeds', () => {
  const url = '/redline/artifacts/0123456789abcdef/settings/Accounts.html'
  it('keeps HTML and canvas embeds that point at artifact routes, and errors', () => {
    const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', embeds: [
      { src: 'a.html', kind: 'html', path: '/w/.canvas/a.html', url },
      { src: '.canvas/settings', kind: 'canvas', path: '/w/.canvas/settings', url: '/redline/artifacts/0123456789abcdef/', title: 'Settings', frames: [
        { id: 'accounts', title: 'Accounts', url, w: 390, h: 844 },
        { id: 'bad id', title: 'x', url },
        { id: 'web', title: 'x', url: 'https://example.com/a.html' },
        { id: 'big', title: 'Big', url, w: -1, h: 'tall' },
      ] },
      { src: 'b.html', kind: 'html', path: '/w/b.html', error: 'not-embeddable' },
      { src: 'gone.html', kind: 'html', error: 'missing' },
    ] })
    expect(parsed?.kind === 'assistant_message' && parsed.embeds).toEqual([
      { src: 'a.html', kind: 'html', path: '/w/.canvas/a.html', url },
      { src: '.canvas/settings', kind: 'canvas', path: '/w/.canvas/settings', url: '/redline/artifacts/0123456789abcdef/', title: 'Settings', frames: [
        { id: 'accounts', title: 'Accounts', url, w: 390, h: 844 },
        { id: 'big', title: 'Big', url },
      ] },
      { src: 'b.html', kind: 'html', path: '/w/b.html', error: 'not-embeddable' },
      { src: 'gone.html', kind: 'html', error: 'missing' },
    ])
  })

  it.each([
    ['a web page', 'https://example.com/a.html'],
    ['a protocol-relative page', '//example.com/a.html'],
    ['another daemon route', '/api/pane-management/panes'],
    ['a short artifact id', '/redline/artifacts/0123/a.html'],
    ['a dot segment', '/redline/artifacts/0123456789abcdef/../../api'],
    ['an encoded dot segment', '/redline/artifacts/0123456789abcdef/%2E%2E/x'],
    ['a half-encoded dot segment', '/redline/artifacts/0123456789abcdef/.%2e/x'],
    ['an encoded single dot', '/redline/artifacts/0123456789abcdef/%2e/x'],
    ['a trailing dot segment', '/redline/artifacts/0123456789abcdef/a/..'],
    ['an encoded slash', '/redline/artifacts/0123456789abcdef/..%2Fapi'],
    ['an encoded backslash', '/redline/artifacts/0123456789abcdef/%5C..%5Capi'],
    ['broken percent-encoding', '/redline/artifacts/0123456789abcdef/%E0%A4%A.html'],
    ['a query', '/redline/artifacts/0123456789abcdef/a.html?x=1'],
    ['a backslash', '/redline/artifacts/0123456789abcdef/a\\b.html'],
  ])('drops an embed whose url is %s', (_name, bad) => {
    const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', embeds: [{ src: 'a.html', kind: 'html', url: bad }] })
    expect(parsed?.kind === 'assistant_message' && parsed.embeds).toBeUndefined()
  })

  it('keeps encoded names that are not dot segments', () => {
    const url = '/redline/artifacts/0123456789abcdef/My%20Page%2E.html'
    const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', embeds: [{ src: 'a.html', kind: 'html', url }] })
    expect(parsed?.kind === 'assistant_message' && parsed.embeds?.[0].url).toBe(url)
  })

  it('drops unknown kinds and errors, and caps the list', () => {
    const parsed = parseChatItem({ ...base, kind: 'assistant_message', text: 'x', embeds: [
      { src: 'a.html', kind: 'pdf', url }, { src: 'a.html', kind: 'html', error: 'nope' }, ...Array(20).fill({ src: 'a.html', kind: 'html', url }),
    ] })
    expect(parsed?.kind === 'assistant_message' && parsed.embeds).toHaveLength(8)
  })

  it('finds an embed by its address, encoded or not', () => {
    const embeds = [{ src: '.canvas/My Board', kind: 'canvas' as const, error: 'missing' as const }]
    expect(findChatReplyEmbed(embeds, '.canvas/My%20Board')).toBe(embeds[0])
    expect(findChatReplyEmbed(embeds, '.canvas/Other')).toBeUndefined()
  })
})
