// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSessionInfo, ChatState } from '../../shared/agent-chat'
import { PaneAgentSwitch } from '../PaneAgentSwitch'
import { PaneContextMenu } from '../PaneContextMenu'
import { ChatComposer, type ChatDraft } from './ChatComposer'
import { ChatPane, type ChatFlowServices } from './ChatPane'

const imageId = `${'c'.repeat(64)}.png`
const session: ChatSessionInfo = { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 5, sessionId: 'abcd1234-0000', permissionMode: 'default' }

afterEach(cleanup)

function composer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
  render(<ChatComposer session={session} hostConnected requests={[]} {...handlers} {...props} />)
  return { ...handlers, input: screen.getByRole('textbox', { name: 'Message Claude' }) as HTMLTextAreaElement }
}

function flow(overrides: Partial<ChatFlowServices> = {}): ChatFlowServices {
  return { queue: vi.fn(), task: vi.fn(), subagentTranscript: vi.fn(async () => ({ items: [] })), savePlan: vi.fn(async () => ({ path: '/p.md' })), ...overrides } as ChatFlowServices
}

describe('switching a chat to Claude Code', () => {
  it('lets a switch read the unsent draft, and locks the composer while it waits for the turn', () => {
    let read: (() => ChatDraft) | null = null
    const { input } = composer({ registerDraft: (next) => { read = next } })
    fireEvent.change(input, { target: { value: 'half-written thought' } })
    expect(read!()).toEqual({ text: 'half-written thought', images: [] })
    cleanup()
    composer({ session: { ...session, status: 'running', claudeCodeSwitch: 'after_turn' } })
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveAttribute('placeholder', 'Switching to Claude Code…')
    // Stop still works, so the turn can be ended to switch sooner.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('puts what the chat carried back into the composer once, queue before draft', () => {
    const onCarriedTaken = vi.fn()
    const carried = { id: 'carry-1', text: 'queued\n\ndraft', images: [{ id: imageId, name: 'shot.png' }] }
    const { input } = composer({ carried, onCarriedTaken })
    expect(input.value).toBe('queued\n\ndraft')
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeInTheDocument()
    expect(onCarriedTaken).toHaveBeenCalledWith('carry-1', 1)
    cleanup()
    // A remount before the daemon cleared it doesn't add it twice.
    const again = composer({ carried, onCarriedTaken })
    expect(again.input.value).toBe('')
  })

  it('restores only the carried images that fit, and the rest once there is room', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `${String(index % 10).repeat(64)}.png`, name: `shot-${index}.png` }))
    const onCarriedTaken = vi.fn()
    const { rerender } = render(<ChatComposer session={session} hostConnected requests={[]} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} carried={{ id: 'carry-many', text: 'with images', images: many }} onCarriedTaken={onCarriedTaken} />)
    expect(screen.getAllByRole('img')).toHaveLength(10)
    expect(onCarriedTaken).toHaveBeenLastCalledWith('carry-many', 10)
    expect(screen.getByRole('alert')).toHaveTextContent("2 images from before Claude Code don't fit in this message yet")
    // The daemon offers the two left over; with no room they wait, unreported.
    const left = { id: 'carry-left', text: '', images: many.slice(10) }
    rerender(<ChatComposer session={session} hostConnected requests={[]} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} carried={left} onCarriedTaken={onCarriedTaken} />)
    expect(onCarriedTaken).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove/ })[0]!)
    expect(onCarriedTaken).toHaveBeenLastCalledWith('carry-left', 1)
    expect(screen.getAllByRole('img')).toHaveLength(10)
  })

  it('leaves a carried draft with Commando while a switch waits', () => {
    const onCarriedTaken = vi.fn()
    const { input } = composer({ session: { ...session, claudeCodeSwitch: 'after_turn' }, carried: { id: 'carry-wait', text: 'later', images: [] }, onCarriedTaken })
    expect(input.value).toBe('')
    expect(onCarriedTaken).not.toHaveBeenCalled()
  })

  it('tells the app while an image uploads, so a switch waits for it', async () => {
    let finish!: (ref: { id: string; name: string }) => void
    const uploadImage = vi.fn(() => new Promise<{ id: string; name: string }>((resolve) => { finish = resolve }))
    const onUploadingChange = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 80, height: 60, close: () => {} })))
    const services = { searchFiles: vi.fn(), pullRequests: vi.fn(), uploadImage } as never
    composer({ services, onUploadingChange })
    fireEvent.change(screen.getByTestId('chat-image-input'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true))
    finish({ id: imageId, name: 'shot.png' })
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false))
    vi.unstubAllGlobals()
  })

  it('shows the wait with Cancel and Switch now', () => {
    const switchToClaudeCode = vi.fn()
    const chat: ChatState = { paneId: '%5', session: { ...session, status: 'running', claudeCodeSwitch: 'after_turn' }, items: [], hostConnected: true }
    const { rerender } = render(<ChatPane chat={chat} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} flow={flow({ switchToClaudeCode })} />)
    expect(screen.getByTestId('claude-code-switch')).toHaveTextContent('Switching to Claude Code when this turn ends…')
    fireEvent.click(screen.getByRole('button', { name: 'Switch now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(switchToClaudeCode.mock.calls).toEqual([['now'], ['cancel']])
    rerender(<ChatPane chat={{ ...chat, session: { ...chat.session, claudeCodeSwitch: 'switching' } }} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} flow={flow({ switchToClaudeCode })} />)
    expect(screen.getByTestId('claude-code-switch')).toHaveTextContent('Switching to Claude Code…')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

describe('PaneAgentSwitch', () => {
  it('switches a chat to Claude Code, and Claude Code back to the chat', () => {
    const onChat = vi.fn()
    const onClaudeCode = vi.fn()
    const { rerender } = render(<PaneAgentSwitch mode="chat" onChat={onChat} onClaudeCode={onClaudeCode} />)
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    expect(onClaudeCode).toHaveBeenCalledTimes(1)
    rerender(<PaneAgentSwitch mode="claude-code" onChat={onChat} onClaudeCode={onClaudeCode} />)
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(onClaudeCode).toHaveBeenCalledTimes(1)
    expect(onChat).toHaveBeenCalledTimes(1)
    rerender(<PaneAgentSwitch mode="chat" claudeCodeDisabled claudeCodeTitle="Send a message first" onChat={onChat} onClaudeCode={onClaudeCode} />)
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('title', 'Send a message first')
  })

  it('moves the host log to the pane menu, and offers Back to chat from Claude Code', () => {
    const onChatView = vi.fn()
    const onReturnToChat = vi.fn()
    const common = { paneLabel: 'chat', x: 10, y: 10, onClose: vi.fn(), onRename: vi.fn(), onSplit: vi.fn(), onKill: vi.fn() }
    const { rerender } = render(<PaneContextMenu {...common} chatView="chat" onChatView={onChatView} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show host log' }))
    expect(onChatView).toHaveBeenCalledWith('terminal')
    rerender(<PaneContextMenu {...common} onReturnToChat={onReturnToChat} />)
    expect(screen.queryByRole('menuitem', { name: 'Show host log' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back to chat' }))
    expect(onReturnToChat).toHaveBeenCalledTimes(1)
  })
})
