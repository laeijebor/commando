// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Code, Maximize2 } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatReplyDiagram } from '../../shared/agent-chat'
import { prDiagramHash } from '../../shared/pr-diagram'
import { ChatBlock } from './ChatBlock'
import { Markdown } from './ChatTimeline'
import { DiagramBlock, standaloneSvg } from './DiagramBlock'
import { isDiagramImage } from './ReplyImage'

const host = vi.hoisted(() => ({ local: true }))
vi.mock('../HostContext', () => ({ useHost: () => host }))
afterEach(() => { cleanup(); host.local = true; vi.unstubAllGlobals() })

function stubClipboard(write: (items: unknown[]) => Promise<void> = async () => {}) {
  const clipboard = { writeText: vi.fn(async (_text: string) => {}), write: vi.fn(write) }
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, unknown>) {} })
  return clipboard
}

describe('ChatBlock', () => {
  it('shows a caption with title and detail, a floating toolbar and ghost actions', () => {
    const expand = vi.fn()
    const source = vi.fn()
    render(<ChatBlock title="Architecture" detail="architecture.svg" toolbar={[{ key: 'x', label: 'Expand', icon: Maximize2, onSelect: expand }]}
      actions={[{ key: 's', label: 'Show source', text: 'Source', icon: Code, pressed: false, onSelect: source }]} status="Copied"><p>picture</p></ChatBlock>)
    const block = screen.getByRole('figure', { name: 'Architecture' })
    expect(block).toHaveTextContent('Architecture · architecture.svg')
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Expand' }))
    expect(expand).toHaveBeenCalledOnce()
    const toggle = screen.getByRole('button', { name: 'Show source' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveTextContent('Source')
    fireEvent.click(toggle)
    expect(source).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('restores a maximised block on Escape', () => {
    const change = vi.fn()
    const { container, rerender } = render(<ChatBlock title="Mock" maximised onMaximisedChange={change}>x</ChatBlock>)
    expect(container.querySelector('.chat-block')).toHaveAttribute('data-maximised')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(change).toHaveBeenCalledWith(false)
    rerender(<ChatBlock title="Mock" onMaximisedChange={change}>x</ChatBlock>)
    expect(container.querySelector('.chat-block')).not.toHaveAttribute('data-maximised')
  })

  it('renders as spans inside a paragraph', () => {
    const { container } = render(<p><ChatBlock title="Inline" inline toolbar={[{ key: 'x', label: 'Expand', icon: Maximize2, onSelect: () => {} }]}>x</ChatBlock></p>)
    expect(container.querySelector('p div, p figure, p figcaption')).toBeNull()
    expect(screen.getByRole('figure', { name: 'Inline' })).toBeInTheDocument()
  })
})

describe('DiagramBlock', () => {
  const svg = () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'

  it('toggles between the picture and the source, and copies what is shown', async () => {
    const clipboard = stubClipboard()
    render(<DiagramBlock title="Flowchart" detail="mermaid" source={'graph LR\n  A --> B'} svg={svg}><span data-testid="picture" /></DiagramBlock>)
    expect(screen.getByTestId('picture')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }))
    expect(screen.queryByTestId('picture')).toBeNull()
    expect(screen.getByText(/A --> B/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy source' }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('graph LR\n  A --> B'))
    expect(await screen.findByRole('status')).toHaveTextContent('Copied source')
    fireEvent.click(screen.getByRole('button', { name: 'Show diagram' }))
    expect(screen.getByTestId('picture')).toBeInTheDocument()
  })

  it('copies the picture as a PNG, and falls back to the SVG text when the image clipboard fails', async () => {
    const clipboard = stubClipboard(async () => { throw new Error('denied') })
    render(<DiagramBlock title="Flowchart" source="graph LR" svg={svg}><span /></DiagramBlock>)
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(svg()))
    expect(clipboard.write).toHaveBeenCalledWith([expect.objectContaining({ items: { 'image/png': expect.any(Promise) } })])
    expect(await screen.findByRole('status')).toHaveTextContent('Copied SVG')
  })

  it('expands a stored picture in the viewer', async () => {
    render(<DiagramBlock title="Pipeline" imageUrl="/chat-images/x.svg"><img alt="Pipeline" src="/chat-images/x.svg" /></DiagramBlock>)
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    const viewer = await screen.findByRole('dialog', { name: 'Pipeline' })
    expect(within(viewer).getByRole('img', { name: 'Pipeline' })).toHaveAttribute('src', '/chat-images/x.svg')
  })

  it('reveals a local file and opens it as a tile, only on this Mac', async () => {
    const onAction = vi.fn(async (_path: string, action: string) => ({ ok: true as const, performed: action as 'tile' }))
    const { rerender } = render(<DiagramBlock title="Architecture" imageUrl="/chat-images/x.svg" file={{ path: '/work/.pr/a.svg', onAction }}><img alt="" /></DiagramBlock>)
    fireEvent.click(screen.getByRole('button', { name: 'Open as tile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    await waitFor(() => expect(onAction.mock.calls).toEqual([['/work/.pr/a.svg', 'tile'], ['/work/.pr/a.svg', 'reveal']]))
    host.local = false
    rerender(<DiagramBlock title="Architecture" imageUrl="/chat-images/x.svg" file={{ path: '/work/.pr/a.svg', onAction }}><img alt="" /></DiagramBlock>)
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open as tile' })).toBeNull()
  })

  it('makes a sized standalone SVG from a rendered one', () => {
    const holder = document.createElement('div')
    holder.innerHTML = '<svg viewBox="0 0 120.5 40" width="100%" style="max-width: 120px"><text>hi</text></svg>'
    const markup = standaloneSvg(holder.querySelector('svg')!)
    expect(markup).toContain('width="121"')
    expect(markup).toContain('height="40"')
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(markup).not.toContain('max-width')
  })
})

describe('pr-diagram fences in a reply', () => {
  const source = '{ "type": "pipeline", "title": "Ship it" }'
  const text = `Here:\n\n\`\`\`pr-diagram\n${source}\n\`\`\`\n`
  const hash = prDiagramHash(source)
  const draw = (diagrams?: ChatReplyDiagram[], running = false) => <Markdown text={text} diagrams={diagrams} running={running} />

  it('shows the rendered SVG with its title and type, and a placeholder while streaming', () => {
    const { rerender } = render(draw(undefined, true))
    expect(screen.getByRole('status')).toHaveTextContent('Rendering diagram…')
    rerender(draw([{ hash, id: `${'a'.repeat(64)}.svg` }]))
    const block = screen.getByRole('figure', { name: 'Ship it' })
    expect(block).toHaveTextContent('Ship it · pr-diagram pipeline')
    expect(within(block).getByRole('img', { name: 'Ship it' })).toHaveAttribute('src', `/chat-images/${'a'.repeat(64)}.svg`)
    fireEvent.click(within(block).getByRole('button', { name: 'Show source' }))
    expect(within(block).getByText(/"type": "pipeline"/)).toBeInTheDocument()
  })

  it('shows a validation error above the source instead of a picture', () => {
    render(draw([{ hash, error: 'invalid', message: 'stages: is required' }]))
    const block = screen.getByRole('figure', { name: 'Ship it' })
    expect(within(block).getByRole('alert')).toHaveTextContent("This pr-diagram document isn't valid: stages: is required")
    expect(within(block).getByText(/"type": "pipeline"/)).toBeInTheDocument()
    expect(within(block).queryByRole('img')).toBeNull()
    expect(within(block).queryByRole('button', { name: 'Show source' })).toBeNull()
  })

  it('stays a code block, with a note, when the renderer is missing or nothing was attached', () => {
    const { container, rerender } = render(draw([{ hash, error: 'renderer_missing' }]))
    expect(screen.getByText('pr-diagram renderer not found')).toBeInTheDocument()
    expect(container.querySelector('pre code')).toHaveTextContent('"title": "Ship it"')
    rerender(draw([{ hash: 'b'.repeat(64), id: `${'a'.repeat(64)}.svg` }]))
    expect(screen.queryByRole('figure')).toBeNull()
    expect(container.querySelector('pre code')).toHaveTextContent('"title": "Ship it"')
  })
})

describe('isDiagramImage', () => {
  it('treats SVGs and PNGs named as diagrams as diagrams, and keeps screenshots plain', () => {
    expect(isDiagramImage(`${'a'.repeat(64)}.svg`, 'shot.svg', '')).toBe(true)
    expect(isDiagramImage(`${'a'.repeat(64)}.png`, '/x/architecture.png', '')).toBe(true)
    expect(isDiagramImage(`${'a'.repeat(64)}.png`, '/x/shot.png', 'Sequence diagram')).toBe(true)
    expect(isDiagramImage(`${'a'.repeat(64)}.png`, '/x/Screenshot 2026.png', 'Login screen')).toBe(false)
    expect(isDiagramImage(`${'a'.repeat(64)}.jpg`, '/x/diagram.jpg', '')).toBe(false)
  })
})

