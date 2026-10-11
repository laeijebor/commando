// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatCommand, ChatItem, ChatSessionInfo, ChatState } from '../../shared/agent-chat'
import { ChatComposer, type ChatInputServices } from './ChatComposer'
import { ChatPane } from './ChatPane'

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

  it('says when Claude has not listed its commands yet', () => {
    const { type } = renderComposer({ commands: undefined })
    type('/zz')
    expect(screen.getByRole('status')).toHaveTextContent("Claude's commands appear once the session has started")
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

  it('shows why the daemon refused a send', () => {
    const onDismissSendError = vi.fn()
    renderComposer({ sendError: 'An attached image is no longer stored; attach it again', onDismissSendError })
    expect(screen.getByRole('alert')).toHaveTextContent('no longer stored')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismissSendError).toHaveBeenCalled()
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
})
