// @vitest-environment jsdom

import { useMemo, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSessionInfo } from '../../shared/agent-chat'
import type { ChatStashEntry, ChatStashInput } from '../../shared/chat-stash'
import { ChatComposer, type ChatInputServices } from './ChatComposer'
import { ChatStashContext, type ChatStash } from './chatStash'

const imageId = `${'a'.repeat(64)}.png`
const session: ChatSessionInfo = { paneId: '%5', provider: 'claude', cwd: '/work/app', status: 'idle', hostPid: 1, hostVersion: 3, sessionId: 'session-1', title: 'Fix login', permissionMode: 'default' }
const services: ChatInputServices = {
  searchFiles: async () => ({ entries: [], truncated: false }),
  pullRequests: async () => [],
  uploadImage: async (image) => ({ id: imageId, name: image.name }),
}

let nextId = 0
const entry = (text: string, overrides: Partial<ChatStashEntry> = {}): ChatStashEntry => ({
  id: (nextId++).toString(16).padStart(32, '0'),
  createdAt: Date.now() - 5 * 60_000,
  text,
  images: [],
  source: { paneId: '%9', title: 'Other chat' },
  ...overrides,
})

/** A stash that behaves like the daemon's: entries update after each change. */
function setup(initial: ChatStashEntry[] = [], options: { failPush?: boolean; missingImages?: number } = {}) {
  const pushed: ChatStashInput[] = []
  const taken: string[] = []
  const onSend = vi.fn()
  function Harness() {
    const [entries, setEntries] = useState(initial)
    const stash = useMemo<ChatStash>(() => ({
      entries,
      push: async (input) => {
        pushed.push(input)
        if (options.failPush) throw new Error('Disk full')
        const created = entry(input.text, { images: input.images, source: input.source, createdAt: Date.now() })
        setEntries((current) => [created, ...current])
        return created
      },
      take: async (id) => {
        taken.push(id)
        const found = entries.find((candidate) => candidate.id === id)
        setEntries((current) => current.filter((candidate) => candidate.id !== id))
        return found ? { entry: found, missingImages: options.missingImages ?? 0 } : null
      },
    }), [entries])
    return (
      <ChatStashContext.Provider value={stash}>
        <ChatComposer session={session} hostConnected requests={[]} services={services} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />
      </ChatStashContext.Provider>
    )
  }
  render(<Harness />)
  const input = screen.getByRole('textbox', { name: 'Message Claude' }) as HTMLTextAreaElement
  const type = (value: string) => fireEvent.change(input, { target: { value } })
  const press = (key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) => fireEvent.keyDown(input, { key, ...modifiers })
  return { input, type, press, pushed, taken, onSend }
}

const stashMenu = () => screen.getByTestId('stash-menu')
const stashRows = () => within(stashMenu()).queryAllByRole('option')

beforeEach(() => {
  let next = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${next++}`), revokeObjectURL: vi.fn() }))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: () => {} })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('stash and pop with Ctrl+S', () => {
  it('stashes the draft with its chat and clears the composer, without the Save dialog', async () => {
    const { input, type, press, pushed } = setup()
    type('half-written thought')
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(input.value).toBe('')
    await waitFor(() => expect(screen.getByRole('button', { name: /1 stashed/ })).toBeInTheDocument())
    expect(pushed).toEqual([{ text: 'half-written thought', images: [], source: { paneId: '%5', sessionId: 'session-1', title: 'Fix login', cwd: '/work/app' } }])

    press('s', { ctrlKey: true })
    await waitFor(() => expect(input.value).toBe('half-written thought'))
    expect(screen.queryByRole('button', { name: /stashed/ })).not.toBeInTheDocument()
  })

  it('pops the newest entry with its images on an empty composer', async () => {
    const older = entry('older')
    const newest = entry('newest', { images: [{ id: imageId, name: 'shot.png' }] })
    const { input, press, taken } = setup([newest, older])
    press('s', { ctrlKey: true })
    await waitFor(() => expect(input.value).toBe('newest'))
    expect(taken).toEqual([newest.id])
    expect(screen.getByRole('button', { name: 'Open shot.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 stashed/ })).toBeInTheDocument()
  })

  it('stashes images along with the text, and an image-only draft', async () => {
    const { input, press, pushed } = setup()
    fireEvent.paste(input, { clipboardData: { files: [new File([new Uint8Array(100)], 'shot.png', { type: 'image/png' })], types: ['Files'] } })
    // Still uploading: the draft can't go whole, so it stays.
    press('s', { ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Wait for the images to finish uploading')
    expect(pushed).toEqual([])
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull())
    press('s', { ctrlKey: true })
    await waitFor(() => expect(pushed).toHaveLength(1))
    expect(pushed[0]).toMatchObject({ text: '', images: [{ id: imageId, name: 'shot.png' }] })
    expect(screen.queryByRole('button', { name: 'Open shot.png' })).not.toBeInTheDocument()
  })

  it('puts the draft back when the stash cannot be saved', async () => {
    const { input, type, press } = setup([], { failPush: true })
    type('keep me')
    press('s', { ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Disk full'))
    expect(input.value).toBe('keep me')
  })

  it('does nothing on an empty composer with an empty stash, and leaves Cmd+S alone', () => {
    const { input, press, taken, pushed } = setup()
    press('s', { ctrlKey: true })
    const save = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(save) })
    expect(save.defaultPrevented).toBe(false)
    expect(taken).toEqual([])
    expect(pushed).toEqual([])
  })

  it('says when stashed images are no longer stored', async () => {
    const { input, press } = setup([entry('with images', { images: [{ id: imageId }] })], { missingImages: 1 })
    press('s', { ctrlKey: true })
    await waitFor(() => expect(input.value).toBe('with images'))
    expect(screen.getByRole('alert')).toHaveTextContent('1 stashed image is no longer stored')
  })
})

describe('the stash menu', () => {
  it('lists entries newest first with their chat, images and age', () => {
    const { press } = setup([entry('second\nline two', { images: [{ id: imageId }, { id: imageId }] }), entry('first', { source: { paneId: '%5', title: 'Fix login' } })])
    press('S', { ctrlKey: true, shiftKey: true })
    const rows = stashRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('second line two')
    expect(rows[0]).toHaveTextContent('2')
    expect(rows[0]).toHaveTextContent('Other chat · %9')
    expect(rows[0]).toHaveTextContent('5m ago')
    expect(rows[1]).toHaveTextContent('Fix login · this chat')
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('opens from the chip and closes with Esc', () => {
    const { press } = setup([entry('one')])
    fireEvent.click(screen.getByRole('button', { name: /1 stashed/ }))
    expect(stashMenu()).toBeInTheDocument()
    press('Escape')
    expect(screen.queryByTestId('stash-menu')).not.toBeInTheDocument()
  })

  it('moves with the arrows and restores with Enter', async () => {
    const first = entry('first')
    const second = entry('second')
    const { input, press, taken, onSend } = setup([first, second])
    press('S', { ctrlKey: true, shiftKey: true })
    press('ArrowDown')
    expect(stashRows()[1]).toHaveAttribute('aria-selected', 'true')
    press('ArrowDown')
    expect(stashRows()[0]).toHaveAttribute('aria-selected', 'true')
    press('ArrowUp')
    press('Enter')
    await waitFor(() => expect(input.value).toBe('second'))
    expect(taken).toEqual([second.id])
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stash-menu')).not.toBeInTheDocument()
  })

  it('stashes the current draft before restoring, so nothing is lost', async () => {
    const saved = entry('from the stash')
    const { input, type, press, pushed } = setup([saved])
    type('typed just now')
    press('S', { ctrlKey: true, shiftKey: true })
    press('Enter')
    await waitFor(() => expect(input.value).toBe('from the stash'))
    expect(pushed.map((draft) => draft.text)).toEqual(['typed just now'])
    expect(screen.getByRole('button', { name: /1 stashed/ })).toBeInTheDocument()
  })

  it('removes the highlighted entry with Delete or Backspace, keeping the composer', async () => {
    const first = entry('first')
    const second = entry('second')
    const third = entry('third')
    const { input, type, press, taken } = setup([first, second, third])
    type('draft stays')
    press('S', { ctrlKey: true, shiftKey: true })
    press('ArrowDown')
    press('Delete')
    await waitFor(() => expect(stashRows()).toHaveLength(2))
    expect(taken).toEqual([second.id])
    expect(stashRows()[1]).toHaveAttribute('aria-selected', 'true')
    press('Backspace')
    await waitFor(() => expect(stashRows()).toHaveLength(1))
    expect(taken).toEqual([second.id, third.id])
    expect(input.value).toBe('draft stays')
  })

  it('restores with a click and removes with the row’s X', async () => {
    const first = entry('first')
    const second = entry('second')
    const { input, taken } = setup([first, second])
    fireEvent.click(screen.getByRole('button', { name: /2 stashed/ }))
    fireEvent.click(within(stashRows()[1]!).getByRole('button', { name: 'Remove from stash' }))
    await waitFor(() => expect(stashRows()).toHaveLength(1))
    expect(input.value).toBe('')
    fireEvent.click(stashRows()[0]!)
    await waitFor(() => expect(input.value).toBe('first'))
    expect(taken).toEqual([second.id, first.id])
  })

  it('takes precedence over the / menu', () => {
    const { type, press } = setup([entry('one')])
    type('/')
    expect(screen.getByTestId('composer-menu')).toBeInTheDocument()
    press('S', { ctrlKey: true, shiftKey: true })
    expect(stashMenu()).toBeInTheDocument()
    expect(screen.queryByTestId('composer-menu')).not.toBeInTheDocument()
  })

  it('shows an empty list from the shortcut, and Enter there sends nothing', () => {
    const { press, onSend } = setup()
    press('S', { ctrlKey: true, shiftKey: true })
    expect(stashMenu()).toHaveTextContent('Nothing stashed')
    press('Enter')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stash-menu')).not.toBeInTheDocument()
  })
})

describe('line editing in the composer', () => {
  it('moves within the line with Ctrl+A and Ctrl+E but keeps Cmd+A', () => {
    const { input, type, press } = setup()
    type('one\ntwo three')
    input.setSelectionRange(8, 8)
    press('a', { ctrlKey: true })
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4])
    press('e', { ctrlKey: true })
    expect([input.selectionStart, input.selectionEnd]).toEqual([13, 13])
    const selectAll = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(selectAll) })
    expect(selectAll.defaultPrevented).toBe(false)
  })

  it('inserts a newline with Ctrl+J instead of sending', () => {
    const { input, type, press, onSend } = setup()
    type('ab')
    input.setSelectionRange(1, 1)
    press('j', { ctrlKey: true })
    expect(input.value).toBe('a\nb')
    expect(onSend).not.toHaveBeenCalled()
    press('Enter')
    expect(onSend).toHaveBeenCalledWith('a\nb')
  })

  it('leaves the / menu its own keys', () => {
    const { input, type, press } = setup()
    type('/')
    expect(screen.getByTestId('composer-menu')).toBeInTheDocument()
    press('Escape')
    expect(screen.queryByTestId('composer-menu')).not.toBeInTheDocument()
    expect(input.value).toBe('/')
  })
})
