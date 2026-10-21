// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatCommand, ChatItem, ChatSessionInfo, ChatState } from '../../shared/agent-chat'
import { ChatComposer, type ChatInputServices, type ChatSendError } from './ChatComposer'
import { ChatPane } from './ChatPane'
import { readDraft, saveDraft } from './draftStore'

const imageId = `${'a'.repeat(64)}.png`
const commands: ChatCommand[] = [
  { name: 'recap', description: 'One-line recap', kind: 'command' },
  { name: 'rename', description: 'Rename the conversation', argumentHint: '[name]', kind: 'command' },
  { name: 'compact', description: 'Free up context', kind: 'command' },
  { name: 'redline', description: 'Review in a tile', kind: 'skill' },
]
const models = [{ value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', efforts: ['low' as const, 'high' as const] }]
const session: ChatSessionInfo = { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 3, model: 'claude-haiku-5-5', models, permissionMode: 'default' }

function services(overrides: Partial<ChatInputServices> = {}): ChatInputServices {
  return {
    searchFiles: vi.fn(async (query: string) => ({ entries: [{ path: `src/${query}.ts`, kind: 'file' as const }, { path: 'src/chat/', kind: 'directory' as const }], truncated: false })),
    pullRequests: vi.fn(async () => [{ number: 32, title: 'Composer controls', url: 'https://github.com/o/r/pull/32' }, { number: 33, title: 'Richer input', url: 'https://github.com/o/r/pull/33', isDraft: true }]),
    uploadImage: vi.fn(async (image) => ({ id: imageId, name: image.name })),
    ...overrides,
  }
}

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
  const view = render(<ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} {...handlers} {...props} />)
  const input = screen.getByRole('textbox', { name: 'Message Claude' }) as HTMLTextAreaElement
  const type = (value: string) => fireEvent.change(input, { target: { value } })
  return { ...handlers, view, input, type }
}

const menu = () => screen.getByTestId('composer-menu')
const options = () => within(menu()).queryAllByRole('option').map((option) => option.textContent)

beforeEach(() => {
  let next = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${next++}`), revokeObjectURL: vi.fn() }))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: () => {} })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('draft persistence', () => {
  const savedSession = { ...session, sessionId: 'draft-session' }
  const savedKey = 'commando:chat-draft:draft-session'

  it('debounces typing and removes the entry immediately when emptied', () => {
    vi.useFakeTimers()
    const { type } = renderComposer({ session: savedSession })
    type('first')
    act(() => { vi.advanceTimersByTime(200) })
    type('latest')
    act(() => { vi.advanceTimersByTime(299) })
    expect(localStorage.getItem(savedKey)).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(readDraft(savedSession.sessionId)).toBe('latest')
    type('')
    expect(localStorage.getItem(savedKey)).toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    expect(localStorage.getItem(savedKey)).toBeNull()
  })

  it('flushes on unmount, restores on remount and clears on sending', () => {
    const first = renderComposer({ session: savedSession })
    first.type('  half typed\nnext line  ')
    first.view.unmount()
    expect(readDraft(savedSession.sessionId)).toBe('  half typed\nnext line  ')
    const second = renderComposer({ session: { ...savedSession, paneId: '%99' } })
    expect(second.input.value).toBe('  half typed\nnext line  ')
    fireEvent.keyDown(second.input, { key: 'Enter' })
    expect(second.onSend).toHaveBeenCalledWith('half typed\nnext line')
    expect(localStorage.getItem(savedKey)).toBeNull()
    second.view.unmount()
    expect(renderComposer({ session: savedSession }).input.value).toBe('')
  })

  it('flushes pagehide and restores after a reload, including a carried draft only once', async () => {
    const first = renderComposer({ session: savedSession })
    first.type('draft before reload')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(readDraft(savedSession.sessionId)).toBe('draft before reload')
    first.view.unmount()
    // A fresh module has no in-memory record of taken carries, as after a page reload.
    vi.resetModules()
    const { ChatComposer: ReloadedComposer } = await import('./ChatComposer')
    const onCarriedTaken = vi.fn()
    render(<ReloadedComposer session={savedSession} hostConnected requests={[]} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} carried={{ id: 'reload-carry', text: 'queued\n\ndraft before reload', images: [] }} onCarriedTaken={onCarriedTaken} />)
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue('queued\n\ndraft before reload')
    expect(onCarriedTaken).toHaveBeenCalledWith('reload-carry', 0)
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(readDraft(savedSession.sessionId)).toBe('queued\n\ndraft before reload')
  })

  it('keeps sessions separate even when a tmux pane id is reused', () => {
    const first = renderComposer({ session: savedSession })
    first.type('private to this chat')
    first.view.unmount()
    const second = renderComposer({ session: { ...savedSession, sessionId: 'another-session' } })
    expect(second.input.value).toBe('')
    expect(localStorage.getItem('commando:chat-draft:%5')).toBeNull()
    expect(readDraft(savedSession.sessionId)).toBe('private to this chat')
  })

  it('restores when the session id arrives, without overwriting text already typed', () => {
    saveDraft(savedSession.sessionId, 'saved earlier')
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
    const first = renderComposer()
    first.view.rerender(<ChatComposer session={savedSession} hostConnected requests={[]} {...handlers} />)
    expect(first.input.value).toBe('saved earlier')
    first.view.unmount()
    const second = renderComposer()
    second.type('typed before the id arrived')
    second.view.rerender(<ChatComposer session={savedSession} hostConnected requests={[]} {...handlers} />)
    expect(second.input.value).toBe('typed before the id arrived')
    second.view.unmount()
    expect(readDraft(savedSession.sessionId)).toBe('typed before the id arrived')
  })

  it('keeps the latest draft under the correct key when the identity changes', () => {
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
    const { type, view } = renderComposer({ session: savedSession })
    type('first session')
    view.rerender(<ChatComposer session={{ ...savedSession, sessionId: 'second-session' }} hostConnected requests={[]} {...handlers} />)
    type('second session')
    view.unmount()
    expect(readDraft(savedSession.sessionId)).toBe('first session')
    expect(readDraft('second-session')).toBe('second session')
  })

  it('restores under StrictMode without duplicating carried text', () => {
    saveDraft(savedSession.sessionId, 'saved thought')
    const onCarriedTaken = vi.fn()
    render(<StrictMode><ChatComposer session={savedSession} hostConnected requests={[]} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} carried={{ id: 'strict-carry', text: 'saved thought', images: [] }} onCarriedTaken={onCarriedTaken} /></StrictMode>)
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue('saved thought')
    expect(onCarriedTaken).toHaveBeenCalledTimes(1)
  })

  it('lets a late carried draft include the saved text while preserving newly typed text', () => {
    saveDraft(savedSession.sessionId, 'saved thought')
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
    const first = renderComposer({ session: savedSession })
    first.view.rerender(<ChatComposer session={savedSession} hostConnected requests={[]} {...handlers} carried={{ id: 'late-carry', text: 'queued\n\nsaved thought', images: [] }} />)
    expect(first.input.value).toBe('queued\n\nsaved thought')
    first.view.unmount()
    const second = renderComposer({ session: { ...savedSession, sessionId: 'new-session' } })
    second.type('typed just now')
    second.view.rerender(<ChatComposer session={{ ...savedSession, sessionId: 'new-session' }} hostConnected requests={[]} {...handlers} carried={{ id: 'new-text-carry', text: 'returned thought', images: [] }} />)
    expect(second.input.value).toBe('returned thought\n\ntyped just now')
  })

  it('keeps uploaded images with the draft when switching away and back', async () => {
    const first = renderComposer({ session: savedSession })
    first.type('describe this image')
    fireEvent.paste(first.input, { clipboardData: { files: [new File(['image'], 'shot.png', { type: 'image/png' })], types: ['Files'] } })
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    first.view.unmount()
    expect(JSON.parse(localStorage.getItem(savedKey)!)).toEqual({ text: 'describe this image', images: [{ id: imageId, name: 'shot.png' }], updatedAt: expect.any(Number) })
    const second = renderComposer({ session: savedSession })
    expect(second.input.value).toBe('describe this image')
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', `/chat-images/${imageId}`)
    fireEvent.keyDown(second.input, { key: 'Enter' })
    expect(second.onSend).toHaveBeenCalledWith('describe this image', [{ id: imageId, name: 'shot.png' }])
    expect(localStorage.getItem(savedKey)).toBeNull()
  })

  it('keeps an image-only draft, and drops it once the image is removed', () => {
    saveDraft(savedSession.sessionId, '', [{ id: imageId, name: 'shot.png' }])
    const { view } = renderComposer({ session: savedSession })
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Remove/ }))
    expect(localStorage.getItem(savedKey)).toBeNull()
    view.unmount()
    renderComposer({ session: savedSession })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('restores saved images when the session id arrives after mount', () => {
    saveDraft(savedSession.sessionId, 'saved earlier', [{ id: imageId, name: 'shot.png' }])
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
    const { view } = renderComposer()
    expect(screen.queryByRole('img')).toBeNull()
    view.rerender(<ChatComposer session={savedSession} hostConnected requests={[]} {...handlers} />)
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeInTheDocument()
  })

  it('continues typing and sending when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked') })
    const { type, input, onSend, view } = renderComposer({ session: savedSession })
    type('still works')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(input.value).toBe('still works')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('still works')
    expect(() => view.unmount()).not.toThrow()
  })
})

describe('the / menu', () => {
  it('lists skills and commands at the start, with Commando’s own entries', () => {
    const { type } = renderComposer()
    type('/')
    expect(within(menu()).getByRole('group', { name: 'Skills' })).toHaveTextContent('/redline')
    const commandGroup = within(menu()).getByRole('group', { name: 'Commands' })
    expect(commandGroup).toHaveTextContent('/model')
    expect(commandGroup).toHaveTextContent('/plan')
    expect(commandGroup).toHaveTextContent('/compact')
    expect(commandGroup).not.toHaveTextContent('moves to start')
  })

  it('offers no /plan in a Muse chat, which has no plan mode', () => {
    render(<ChatComposer session={{ ...session, provider: 'muse' }} hostConnected requests={[]} commands={commands} services={services()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Muse' }), { target: { value: '/' } })
    expect(within(menu()).getByRole('group', { name: 'Commands' })).not.toHaveTextContent('/plan')
  })

  it('filters as you type and inserts the pick with Enter', () => {
    const { input, type, onSend } = renderComposer()
    type('/re')
    // The group with the best match leads: recap and rename before the redline skill.
    expect(options()).toEqual(['/recapOne-line recap', '/rename[name]Rename the conversation', '/redlineReview in a tile'])
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('/rename ')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-menu')).toBeNull()
  })

  it('sends a fully typed command on Enter, as the TUI does', () => {
    const { input, type, onSend } = renderComposer()
    type('/compact')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('/compact')
  })

  it('opens mid-message, runs skills there and moves commands to the start', () => {
    const { input, type } = renderComposer()
    type('please ask for /re')
    expect(within(menu()).getByRole('group', { name: 'Skills' })).toHaveTextContent('Claude can run these mid-message')
    expect(within(menu()).getByRole('group', { name: 'Commands' })).toHaveTextContent('only run at the start of a message')
    expect(options()).toContain('/recapOne-line recapmoves to start')
    type('please ask for /red')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('please ask for /redline ')
    type('keep the notes /comp')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('/compact keep the notes')
  })

  it('stays closed after Esc until the caret leaves the word', () => {
    const { input, type, onInterrupt } = renderComposer()
    type('/re')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('composer-menu')).toBeNull()
    expect(onInterrupt).not.toHaveBeenCalled()
    type('/rec')
    expect(screen.queryByTestId('composer-menu')).toBeNull()
    type('/rec /')
    expect(screen.getByTestId('composer-menu')).toBeInTheDocument()
  })

  it('opens the model menu for /model and switches to plan mode for /plan', async () => {
    const { input, type, onConfigure } = renderComposer()
    type('/mod')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('')
    expect(await screen.findByRole('dialog', { name: 'Model and effort' })).toBeInTheDocument()
    type('/plan')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfigure).toHaveBeenCalledWith({ permissionMode: 'plan' })
  })

  it('leaves plan mode for the pre-plan mode in a Cursor chat, whose default is Sandboxed', () => {
    const { input, type, onConfigure, view } = renderComposer()
    const cursor = { ...session, provider: 'cursor' as const, permissionMode: 'plan' as const, prePlanPermissionMode: 'bypassPermissions' as const }
    view.rerender(<ChatComposer session={cursor} hostConnected requests={[]} commands={commands} services={services()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={onConfigure} />)
    type('/plan')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfigure).toHaveBeenCalledWith({ permissionMode: 'bypassPermissions' })
  })

  it('toggles fast mode with /fast only on a model that offers it', () => {
    const { input, type, onConfigure, view } = renderComposer()
    type('/fas')
    expect(screen.queryByText(/Turn fast mode/)).toBeNull()
    const fastSession = { ...session, fast: true, models: [{ ...models[0]!, supportsFast: true }] }
    view.rerender(<ChatComposer session={fastSession} hostConnected requests={[]} commands={commands} services={services()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={onConfigure} />)
    type('/fast')
    expect(screen.getByTestId('composer-menu')).toHaveTextContent('Turn fast mode off')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfigure).toHaveBeenCalledWith({ fast: false })
  })

  it('says when Claude has not listed its commands yet, or the chat needs a restart', () => {
    const { type, view } = renderComposer({ commands: undefined })
    type('/zz')
    expect(screen.getByRole('status')).toHaveTextContent("Claude's commands appear once the session has started")
    view.rerender(<ChatComposer session={{ ...session, hostVersion: 2 }} hostConnected requests={[]} services={services()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    type('/zzz')
    expect(screen.getByRole('status')).toHaveTextContent("Restart this chat to list Claude's commands")
  })
})

describe('@ and # mentions', () => {
  it('searches files on the host and inserts the path', async () => {
    const search = services()
    const { input, type } = renderComposer({ services: search })
    type('look at @Comp')
    await waitFor(() => expect(options()).toEqual(['Comp.tssrc', 'chat/src']))
    expect(search.searchFiles).toHaveBeenLastCalledWith('Comp')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('look at @src/Comp.ts ')
  })

  it('shows a search error from the host', async () => {
    const { type } = renderComposer({ services: services({ searchFiles: async () => ({ entries: [], truncated: false, error: "Couldn't list files: EACCES" }) }) })
    type('@x')
    expect(await screen.findByText("Couldn't list files: EACCES")).toBeInTheDocument()
  })

  it('lists open pull requests and links the pick', async () => {
    const { input, type } = renderComposer()
    type('compare with #3')
    await waitFor(() => expect(options()).toEqual(['#33Richer input', '#32Composer controls']))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('compare with [#32 Composer controls](https://github.com/o/r/pull/32) ')
  })

  it('leaves @ alone for a chat started before the host could search', () => {
    const { type } = renderComposer({ session: { ...session, hostVersion: 2 } })
    type('@src')
    expect(screen.queryByTestId('composer-menu')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach images' })).toBeNull()
  })
})

describe('image attachments', () => {
  const png = (name = 'shot.png', bytes = 100, type = 'image/png') => new File([new Uint8Array(bytes)], name, { type })
  const paste = (input: HTMLElement, files: File[]) => fireEvent.paste(input, { clipboardData: { files, types: ['Files'] } })

  it('uploads a pasted image and sends it with the text', async () => {
    const upload = services()
    const { input, type, onSend } = renderComposer({ services: upload })
    paste(input, [png()])
    expect(screen.getByRole('button', { name: 'Open shot.png' })).toBeInTheDocument()
    await waitFor(() => expect(upload.uploadImage).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    type('what is this?')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('what is this?', [{ id: imageId, name: 'shot.png' }])
    expect(screen.queryByRole('button', { name: 'Open shot.png' })).toBeNull()
  })

  it('sends an image on its own and lets you remove one first', async () => {
    const { input, onSend } = renderComposer()
    paste(input, [png('a.png'), png('b.png')])
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('', [{ id: imageId, name: 'b.png' }])
  })

  it('accepts dropped files and the 📎 picker', async () => {
    const upload = services()
    renderComposer({ services: upload })
    fireEvent.drop(screen.getByTestId('chat-composer'), { dataTransfer: { files: [png('dropped.png')], types: ['Files'] } })
    fireEvent.change(screen.getByTestId('chat-image-input'), { target: { files: [png('picked.png')] } })
    await waitFor(() => expect(upload.uploadImage).toHaveBeenCalledTimes(2))
  })

  it('refuses unsupported types, oversized images and an eleventh image', async () => {
    const { input } = renderComposer()
    paste(input, [png('vector.svg', 10, 'image/svg+xml')])
    expect(await screen.findByRole('alert')).toHaveTextContent('vector.svg: only PNG, JPEG, GIF and WebP images can be attached')
    paste(input, [png('huge.gif', 11 * 1024 * 1024, 'image/gif')])
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('huge.gif is 11 MB; images must be 10 MB or smaller'))
    paste(input, Array.from({ length: 11 }, (_, index) => png(`p${index}.png`)))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A message can carry at most 10 images'))
    expect(screen.getAllByRole('button', { name: /^Open p\d+\.png$/ })).toHaveLength(10)
  })

  it('holds Send while an upload runs and reports a failed upload', async () => {
    let fail: (error: Error) => void = () => {}
    const { input } = renderComposer({ services: services({ uploadImage: () => new Promise((_resolve, reject) => { fail = reject }) }) })
    paste(input, [png()])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled())
    await act(async () => fail(new Error('Images must be 10 MB or smaller')))
    expect(await screen.findByRole('alert')).toHaveTextContent("shot.png didn't upload: Images must be 10 MB or smaller")
    expect(screen.queryByRole('button', { name: 'Open shot.png' })).toBeNull()
  })

  it('shows why the daemon refused a send and puts the text back', () => {
    const onDismissSendError = vi.fn()
    const onSend = vi.fn(() => 'send-1')
    const { input, type, view } = renderComposer({ onSend, onDismissSendError })
    type('look at this')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('look at this')
    expect(input.value).toBe('')
    view.rerender(<ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={{ message: "Not connected to Commando, so the message wasn't sent", refused: [{ requestId: 'send-1' }] }} onDismissSendError={onDismissSendError} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected to Commando')
    expect(input.value).toBe('look at this')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismissSendError).toHaveBeenCalled()
  })

  it('puts back the refused send, not a later follow-up, with its images', async () => {
    let sends = 0
    const onSend = vi.fn(() => `send-${++sends}`)
    const { input, type, view } = renderComposer({ onSend })
    paste(input, [png('first.png')])
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    type('first, with an image')
    fireEvent.keyDown(input, { key: 'Enter' })
    type('second')
    fireEvent.keyDown(input, { key: 'Enter' })
    type('third, still typing')
    const refuse = (sendError: ChatSendError) => view.rerender(
      <ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={sendError} />,
    )
    refuse({ message: 'No agent host is connected for this pane', refused: [{ requestId: 'send-1', code: 'chat_unavailable' }] })
    expect(input.value).toBe('third, still typing\n\nfirst, with an image')
    expect(screen.getByRole('button', { name: 'Open first.png' })).toBeInTheDocument()
    refuse({ message: 'Send failed', refused: [{ requestId: 'send-1', code: 'chat_unavailable' }, { requestId: 'send-9' }] })
    expect(input.value).toBe('third, still typing\n\nfirst, with an image')
  })

  it('puts back every send in refusals that land together', () => {
    let sends = 0
    const onSend = vi.fn(() => `send-${++sends}`)
    const { input, type, view } = renderComposer({ onSend })
    type('first')
    fireEvent.keyDown(input, { key: 'Enter' })
    type('second')
    fireEvent.keyDown(input, { key: 'Enter' })
    view.rerender(<ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={{ message: 'No agent host is connected for this pane', refused: [{ requestId: 'send-1' }, { requestId: 'send-2' }] }} />)
    expect(input.value).toBe('first\n\nsecond')
  })

  it('leaves out an image the daemon no longer has', async () => {
    const onSend = vi.fn(() => 'send-1')
    const { input, view } = renderComposer({ onSend })
    paste(input, [png('gone.png')])
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    view.rerender(<ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={{ message: 'An attached image is no longer stored; attach it again', refused: [{ requestId: 'send-1', code: 'chat_image_missing' }] }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('attach it again')
    expect(screen.queryByRole('button', { name: 'Open gone.png' })).toBeNull()
  })

  it('says when a refused send’s images no longer fit', async () => {
    const onSend = vi.fn(() => 'send-1')
    const { input, view } = renderComposer({ onSend })
    paste(input, [png('sent.png')])
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    paste(input, Array.from({ length: 10 }, (_, index) => png(`p${index}.png`)))
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    view.rerender(<ChatComposer session={session} hostConnected requests={[]} commands={commands} services={services()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={{ message: 'No agent host is connected for this pane', refused: [{ requestId: 'send-1' }] }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('A message can carry at most 10 images')
    expect(screen.queryByRole('button', { name: 'Open sent.png' })).toBeNull()
  })
})

describe('images in the timeline', () => {
  const base = { turnId: 't1', status: 'completed' as const, createdAt: 1, updatedAt: 1 }

  it('shows message images and tool-result images, and enlarges one on click', async () => {
    const items: ChatItem[] = [
      { ...base, id: 'u1', kind: 'user_message', text: 'what is this?', images: [{ id: imageId, name: 'pane.png' }] },
      { ...base, id: 'read', kind: 'tool', toolUseId: 'r', toolName: 'Read', title: 'Read /work/shot.png', images: [{ id: imageId }] },
    ]
    const state: ChatState = { paneId: '%5', session, items, hostConnected: true }
    render(<ChatPane chat={state} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    expect(screen.getByRole('img', { name: 'pane.png' })).toHaveAttribute('src', `/chat-images/${imageId}`)
    fireEvent.click(screen.getByRole('button', { name: 'Read shot.png' }))
    expect(screen.getByRole('img', { name: 'Image 1' })).toHaveAttribute('src', `/chat-images/${imageId}`)
    fireEvent.click(screen.getByRole('button', { name: 'Open pane.png' }))
    const viewer = await screen.findByRole('dialog', { name: 'pane.png' })
    expect(within(viewer).getByRole('img', { name: 'pane.png' })).toBeInTheDocument()
  })

  it('shows the local images a reply shows with Markdown, and enlarges one on click', async () => {
    const svg = `${'b'.repeat(64)}.svg`
    const text = [
      '![Slide preview](/Users/me/Downloads/slide.png)',
      '![PR diagram](<./out/my diagram.svg>)',
      '![gone](/tmp/gone.png)',
      '![web](https://example.com/chart.png)',
      '![nope](javascript:alert(1))',
      '`~/Downloads/slide.pptx`',
    ].join('\n\n')
    const items: ChatItem[] = [{ ...base, id: 'a1', kind: 'assistant_message', text, images: [
      { src: '/Users/me/Downloads/slide.png', id: imageId },
      { src: './out/my diagram.svg', id: svg },
      { src: '/tmp/gone.png', error: 'missing' },
    ] }]
    const state: ChatState = { paneId: '%5', session, items, hostConnected: true }
    render(<ChatPane chat={state} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    expect(screen.getByRole('img', { name: 'Slide preview' })).toHaveAttribute('src', `/chat-images/${imageId}`)
    expect(screen.getByRole('img', { name: 'PR diagram' })).toHaveAttribute('src', `/chat-images/${svg}`)
    expect(screen.getByRole('img', { name: 'Image not found: /tmp/gone.png' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'web' })).toHaveAttribute('src', 'https://example.com/chart.png')
    expect(screen.getByRole('img', { name: "Image isn't available: javascript:alert(1)" })).toBeInTheDocument()
    expect(document.querySelector('img[src^="javascript:"], img[src^="/Users/"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR diagram' }))
    const viewer = await screen.findByRole('dialog', { name: 'PR diagram' })
    expect(within(viewer).getByRole('img', { name: 'PR diagram' })).toHaveAttribute('src', `/chat-images/${svg}`)
  })

  it('zooms and pans the enlarged image, and fits it again', async () => {
    const items: ChatItem[] = [{ ...base, id: 'u1', kind: 'user_message', text: 'look', images: [{ id: imageId, name: 'wide.png' }] }]
    const state: ChatState = { paneId: '%5', session, items, hostConnected: true }
    render(<ChatPane chat={state} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open wide.png' }))
    const viewer = await screen.findByRole('dialog', { name: 'wide.png' })
    const image = within(viewer).getByRole('img', { name: 'wide.png' })
    Object.defineProperty(image, 'naturalWidth', { value: 4000 })
    Object.defineProperty(image, 'naturalHeight', { value: 1000 })
    fireEvent.load(image)
    const percent = () => within(viewer).getByText(/^\d+%$/).textContent
    const opened = percent()
    expect(within(viewer).getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    fireEvent.click(within(viewer).getByRole('button', { name: 'Zoom in' }))
    expect(Number.parseInt(percent()!)).toBeGreaterThan(Number.parseInt(opened!))
    fireEvent.keyDown(window, { key: '+' })
    const zoomed = image.style.width
    fireEvent.click(within(viewer).getByRole('button', { name: 'Fit to screen' }))
    expect(percent()).toBe(opened)
    expect(image.style.width).not.toBe(zoomed)
    fireEvent.keyDown(window, { key: '0' })
    expect(within(viewer).getByRole('button', { name: 'Fit to screen' })).toBeDisabled()
  })

  it('waits for a streaming reply to store its image instead of showing a broken one', () => {
    const items: ChatItem[] = [{ ...base, id: 'a1', kind: 'assistant_message', status: 'running', text: 'Here: ![Chart](/tmp/chart.png)' }]
    const state: ChatState = { paneId: '%5', session, items, hostConnected: true }
    render(<ChatPane chat={state} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    expect(screen.getByText('Chart')).toBeInTheDocument()
    expect(document.querySelector('img[src="/tmp/chart.png"]')).toBeNull()
  })
})
