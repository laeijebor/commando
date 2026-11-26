// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatReplyEmbed } from '../../shared/agent-chat'
import type { ResourceActionHandler } from '../paneManagementApi'
import { Markdown } from './ChatTimeline'
import { EmbedFrame } from './EmbedFrame'

const host = vi.hoisted(() => ({ local: true }))
vi.mock('../HostContext', () => ({ useHost: () => host }))
afterEach(() => { cleanup(); host.local = true })

const cwd = '/work'
const html: ChatReplyEmbed = { src: '.canvas/settings/Accounts.html', kind: 'html', path: '/work/.canvas/settings/Accounts.html', url: '/redline/artifacts/0123456789abcdef/settings/Accounts.html' }
const canvas: ChatReplyEmbed = {
  src: '.canvas/settings', kind: 'canvas', path: '/work/.canvas/settings', url: '/redline/artifacts/0123456789abcdef/', title: 'Settings board', frames: [
    { id: 'list', title: 'Accounts · list', url: '/redline/artifacts/0123456789abcdef/List.html', w: 640, h: 416 },
    { id: 'teal', title: 'Accounts · teal', url: '/redline/artifacts/0123456789abcdef/Teal.html', w: 390, h: 844 },
  ],
}
const tileAction = () => vi.fn<ResourceActionHandler>(async () => ({ ok: true, performed: 'tile', webPaneId: 'w-12345678' }))

describe('EmbedFrame: HTML mock-up', () => {
  it('shows a sandboxed, lazy frame behind a shield until clicked, then goes live', () => {
    render(<EmbedFrame embed={html} alt="Accounts mock-up" cwd={cwd} />)
    const block = screen.getByRole('figure', { name: 'Accounts mock-up' })
    expect(block).toHaveTextContent('Accounts mock-up · Accounts.html · .canvas/settings')
    const frame = within(block).getByTitle('Accounts mock-up')
    expect(frame).toHaveAttribute('src', `${html.url}?chat-embed=1`)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame).toHaveAttribute('loading', 'lazy')
    expect(frame).toHaveAttribute('tabindex', '-1')
    expect(frame.parentElement).toHaveStyle({ '--chat-embed-height': '320px' })
    expect(within(block).queryByText('Live')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Interact with Accounts mock-up' }))
    expect(within(block).getByText('Live')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Interact with/ })).toBeNull()
    expect(frame).toHaveAttribute('tabindex', '0')
    // Clicking back in the chat ends the live session.
    fireEvent.pointerDown(document.body)
    expect(within(block).queryByText('Live')).toBeNull()
    expect(screen.getByRole('button', { name: 'Interact with Accounts mock-up' })).toBeInTheDocument()
  })

  it('grows taller with the size toggle', () => {
    render(<EmbedFrame embed={html} alt="" cwd={cwd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Taller' }))
    expect(screen.getByTitle('Accounts.html').parentElement).toHaveStyle({ '--chat-embed-height': '640px' })
    expect(screen.getByRole('button', { name: 'Shorter' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('maximises over the chat pane, live, and restores with Esc or Restore', () => {
    const { container } = render(<section data-chat-overlay-root=""><EmbedFrame embed={html} alt="Accounts" cwd={cwd} onAction={tileAction()} /></section>)
    const frame = screen.getByTitle('Accounts')
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    const block = container.querySelector('.chat-embed')!
    expect(block).toHaveAttribute('data-maximised')
    expect(block).toHaveTextContent('maximised in chat')
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Interact with/ })).toBeNull()
    // The same frame element: maximising never reloads the page.
    expect(screen.getByTitle('Accounts')).toBe(frame)
    expect(container.querySelector('.chat-embed-anchor')!.getAttribute('style')).toContain('--chat-embed-max-width')
    for (const name of ['Move to tile', 'Review in a tile', 'Restore (Esc)']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(block).not.toHaveAttribute('data-maximised')
    expect(container.querySelector('.chat-embed-anchor')!.getAttribute('style') ?? '').not.toContain('--chat-embed-max')
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore (Esc)' }))
    expect(block).not.toHaveAttribute('data-maximised')
  })

  it('restores on Esc relayed from its own frame only, and moves focus to Restore and back', () => {
    const { container } = render(<section data-chat-overlay-root=""><EmbedFrame embed={html} alt="Accounts" cwd={cwd} /></section>)
    const block = container.querySelector('.chat-embed')!
    const frame = screen.getByTitle('Accounts') as HTMLIFrameElement
    const escape = (source: MessageEventSource | null, data: unknown = { source: 'commando-canvas-frame', frameId: 'chat-embed', type: 'escape' }) =>
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })) })
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    expect(screen.getByRole('button', { name: 'Restore (Esc)' })).toHaveFocus()
    // Another window, or another message from the frame, changes nothing.
    escape(window)
    escape(frame.contentWindow, { source: 'commando-canvas-frame', type: 'goto', target: 'x' })
    expect(block).toHaveAttribute('data-maximised')
    escape(frame.contentWindow)
    expect(block).not.toHaveAttribute('data-maximised')
    expect(screen.getByRole('button', { name: 'Maximise' })).toHaveFocus()
  })

  it('covers the timeline when no overlay root is marked, and keeps its place in the reply', () => {
    const view = <div className="chat-timeline"><p>Before</p><EmbedFrame embed={html} alt="Accounts" cwd={cwd} /></div>
    const { container, rerender } = render(view)
    const timeline = container.querySelector<HTMLElement>('.chat-timeline')!
    timeline.getBoundingClientRect = () => ({ top: 40, left: 30, width: 600, height: 500, right: 630, bottom: 540, x: 30, y: 40, toJSON: () => ({}) })
    const anchor = container.querySelector<HTMLElement>('.chat-embed-anchor')!
    Object.defineProperty(anchor, 'offsetHeight', { configurable: true, get: () => 358 })
    // The inline height is read as the block renders inline.
    rerender(<div className="chat-timeline"><p>Before</p><EmbedFrame embed={{ ...html }} alt="Accounts" cwd={cwd} onAction={tileAction()} /></div>)
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    expect(anchor.style.getPropertyValue('--chat-embed-max-width')).toBe('600px')
    expect(anchor.style.getPropertyValue('--chat-embed-max-height')).toBe('500px')
    expect(anchor.style.getPropertyValue('--chat-embed-max-top')).toBe('40px')
    expect(anchor.style.height).toBe('358px')
    expect(timeline.style.getPropertyValue('--chat-timeline-width')).not.toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Restore (Esc)' }))
    expect(anchor.style.height).toBe('')
    expect(timeline.style.getPropertyValue('--chat-timeline-width')).toBe('')
  })

  it('moves to a tile and opens a chromium tile for review', async () => {
    const onAction = tileAction()
    const { container } = render(<EmbedFrame embed={html} alt="Accounts" cwd={cwd} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open as tile' }))
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith(html.path, 'tile', undefined, undefined))
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review in a tile' }))
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith(html.path, 'tile', undefined, { engine: 'chromium' }))
    await waitFor(() => expect(container.querySelector('.chat-embed')).not.toHaveAttribute('data-maximised'))
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move to tile' }))
    await waitFor(() => expect(container.querySelector('.chat-embed')).not.toHaveAttribute('data-maximised'))
    expect(onAction).toHaveBeenCalledTimes(3)
  })

  it('says why a tile did not open', async () => {
    const onAction = vi.fn<ResourceActionHandler>(async () => { throw new Error('Resource tiles are unavailable') })
    render(<EmbedFrame embed={html} alt="Accounts" cwd={cwd} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open as tile' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Resource tiles are unavailable')
  })

  it('shows a chip instead of a frame for a refused or missing page, or on another host', () => {
    const onAction = tileAction()
    const { rerender } = render(<EmbedFrame embed={{ src: 'loose.html', kind: 'html', path: '/work/loose.html', error: 'not-embeddable' }} alt="Loose" cwd={cwd} onAction={onAction} />)
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Loose' }))
    expect(onAction).toHaveBeenLastCalledWith('/work/loose.html', 'open', undefined)
    rerender(<EmbedFrame embed={{ src: 'gone.html', kind: 'html', path: '/work/gone.html', error: 'missing' }} alt="" cwd={cwd} onAction={onAction} />)
    expect(screen.getByRole('button', { name: 'gone.html' }).closest('.chat-resource-chip')).toHaveClass('chat-resource-missing')
    host.local = false
    rerender(<EmbedFrame embed={html} alt="Remote" cwd={cwd} onAction={onAction} />)
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remote' })).toBeInTheDocument()
  })
})

describe('EmbedFrame: canvas board', () => {
  it('shows scaled, inert thumbnails with numbers, titles and the frame count', () => {
    render(<EmbedFrame embed={canvas} alt="" cwd={cwd} />)
    const block = screen.getByRole('figure', { name: 'Settings board' })
    expect(block).toHaveTextContent('Settings board · 2 frames')
    const preview = within(block).getByTitle('Preview: Accounts · list')
    expect(preview).toHaveAttribute('sandbox', 'allow-scripts')
    expect(preview).toHaveAttribute('tabindex', '-1')
    expect(preview).toHaveStyle({ width: '640px', height: '416px', transform: `scale(${Math.min(140 / 416, 240 / 640)})` })
    expect(within(block).getByRole('button', { name: 'Open frame 2: Accounts · teal' })).toHaveTextContent('2Accounts · teal')
  })

  it('maximises a clicked frame with tabs to switch, and moves the board to a canvas tile', async () => {
    const onAction = tileAction()
    const { container } = render(<section data-chat-overlay-root=""><EmbedFrame embed={canvas} alt="Board" cwd={cwd} onAction={onAction} /></section>)
    fireEvent.click(screen.getByRole('button', { name: 'Open frame 2: Accounts · teal' }))
    expect(container.querySelector('.chat-embed')).toHaveAttribute('data-maximised')
    const tabs = screen.getByRole('tablist', { name: 'Board frames' })
    expect(within(tabs).getByRole('tab', { selected: true })).toHaveTextContent('Accounts · teal')
    fireEvent.click(within(tabs).getByRole('tab', { name: /Accounts · list/ }))
    expect(within(tabs).getByRole('tab', { selected: true })).toHaveTextContent('Accounts · list')
    fireEvent.click(screen.getByRole('button', { name: 'Move to tile' }))
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith(canvas.path, 'tile', undefined, undefined))
    await waitFor(() => expect(container.querySelector('.chat-embed')).not.toHaveAttribute('data-maximised'))
  })
})

describe('embeds in a streaming reply', () => {
  it('keeps the same frame element across flushes, and renders other images as before', () => {
    const text = 'Here is a first pass.\n\n![Accounts](.canvas/settings/Accounts.html)'
    const { rerender } = render(<Markdown text={text} embeds={[html]} running />)
    const frame = screen.getByTitle('Accounts')
    fireEvent.click(screen.getByRole('button', { name: 'Interact with Accounts' }))
    for (let flush = 1; flush <= 5; flush++) {
      rerender(<Markdown text={`${text}\n\nToggles and Connect work${'.'.repeat(flush)}`} embeds={[{ ...html }]} running />)
    }
    rerender(<Markdown text={`${text}\n\nDone.`} embeds={[{ ...html }]} />)
    expect(screen.getByTitle('Accounts')).toBe(frame)
    expect(frame).toHaveAttribute('src', `${html.url}?chat-embed=1`)
    // Still live: the block itself was not remounted.
    expect(screen.getByText('Live')).toBeInTheDocument()
  })
})
