// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatReplyResource } from '../../shared/agent-chat'
import { Markdown, ChatTimeline } from './ChatTimeline'
import { ResourceChip, ResourceCardList, canTileResource, primaryResourceAction, resourceDirectory } from './ResourceChip'

const host = vi.hoisted(() => ({ local: true }))
vi.mock('../HostContext', () => ({ useHost: () => host }))
afterEach(() => { cleanup(); host.local = true; vi.unstubAllGlobals() })
const file: ChatReplyResource = { ref: './src/main.ts:42', path: '/work/src/main.ts', kind: 'file', size: 1024, mtimeMs: Date.now(), line: 42 }
const folder: ChatReplyResource = { ref: './src', path: '/work/src', kind: 'folder', entries: 3 }
const reply = (text: string, resources: ChatReplyResource[]): ChatItem => ({ id: 'a', turnId: 't', kind: 'assistant_message', status: 'completed', createdAt: 1, updatedAt: 1, text, resources })

describe('resource references in Markdown', () => {
  it('replaces matching links and single-backtick code, preserving labels and external links', () => {
    const { container } = render(<Markdown text={'[source](./src/main.ts:42) `./src/main.ts:42` [web](https://example.com) `unknown.ts`'} resources={[file]} />)
    expect(screen.getByRole('button', { name: 'source' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: './src/main.ts:42' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('href', 'https://example.com')
    expect(container.querySelector('code')).toHaveTextContent('unknown.ts')
  })
  it('preserves file URLs and encoded paths, including reference links', () => {
    const resource: ChatReplyResource = { ref: 'file:///work/my%20file.md', path: '/work/my file.md', kind: 'file' }
    render(<Markdown text={'[file][f]\n\n[f]: file:///work/my%20file.md'} resources={[resource]} />)
    expect(screen.getByRole('button', { name: 'file' }).closest('[title]')).toHaveAttribute('title', resource.path)
  })
  it('never chips fenced code or double backticks, even when another reference matches', () => {
    const { container } = render(<Markdown text={'```\n./src/main.ts:42\n```\n\n``./src/main.ts:42``\n\n`./src/main.ts:42`'} resources={[file]} />)
    expect(container.querySelector('pre button')).toBeNull()
    expect(container.querySelector('pre code')).toHaveTextContent('./src/main.ts:42')
    expect(screen.getAllByRole('button', { name: './src/main.ts:42' })).toHaveLength(1)
  })
  it('avoids nested chips when a link label is itself code', () => {
    const codeLabel: ChatReplyResource = { ...file, ref: 'main.ts' }
    const { container } = render(<Markdown text={'[`main.ts`](./src/main.ts:42)'} resources={[file, codeLabel]} />)
    expect(screen.getAllByRole('button', { name: 'main.ts' })).toHaveLength(1)
    expect(container.querySelector('button button')).toBeNull()
  })
  it.each(['-', '1.'])('groups lists only when every item starts with a resource (%s)', (bullet) => {
    const text = `${bullet} [source](./src/main.ts:42) — **entry point**\n${bullet} \`./src\` folder description`
    const { container } = render(<ChatTimeline items={[reply(text, [file, folder])]} cwd="/work" working={false} />)
    expect(container.querySelector('.chat-resource-cards')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('entry point').tagName).toBe('STRONG')
    expect(screen.getByText('3 items')).toBeInTheDocument()
    expect(screen.getByText('1.0 KB · just now')).toBeInTheDocument()
  })
  it('retains ordinary, mixed and single-item lists', () => {
    const { container } = render(<Markdown text={'- [source](./src/main.ts:42)\n- plain text\n\n1. `./src`'} resources={[file, folder]} />)
    expect(container.querySelector('.chat-resource-cards')).toBeNull()
    expect(container.querySelector('ul')).toBeInTheDocument()
    expect(container.querySelector('ol')).toBeInTheDocument()
  })
})

describe('compact resource cards', () => {
  it.each([' — ', ' – ', ' - ', ' : '])('strips a leading %s separator and preserves inline formatting', (separator) => {
    render(<ResourceCardList rows={[{ resource: file, description: <p>{separator}<strong>the carousel</strong></p> }, { resource: folder }]} cwd="/work" />)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].querySelector('.chat-resource-title')).toHaveTextContent('main.ts · the carousel')
    expect(screen.getByText('the carousel').tagName).toBe('STRONG')
    expect(rows[0].querySelector('p')).toBeNull()
    expect(rows[1].querySelector('.chat-resource-title')).toHaveTextContent(/^src$/)
  })
  it('keeps punctuation within a description', () => {
    render(<ResourceCardList rows={[{ resource: file, description: 'the carousel - updated' }]} cwd="/work" />)
    expect(screen.getByRole('listitem').querySelector('.chat-resource-title')).toHaveTextContent('main.ts · the carousel - updated')
  })
  it.each([
    { resource: folder, name: 'Open', action: 'open', icon: 'folder-open' },
    { resource: { ...file, path: '/work/page.html' }, name: 'Open as tile', action: 'tile', icon: 'panel-top' },
    { resource: file, name: 'Open in editor', action: 'editor', icon: 'code' },
    { resource: { ...file, path: '/work/movie.mov' }, name: 'Open', action: 'open', icon: 'external-link' },
  ])('keeps the $name action accessible with its icon', async ({ resource, name, action, icon }) => {
    const onAction = vi.fn().mockResolvedValue({ ok: true, performed: action })
    render(<ResourceCardList rows={[{ resource }]} cwd="/work" onAction={onAction} />)
    const button = screen.getByRole('button', { name })
    expect(button.querySelector(`.lucide-${icon}`)).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(button)
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(resource.path, action, 'line' in resource ? resource.line : undefined))
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resource actions' })).toBeInTheDocument()
  })
  it('places action errors below the directory', async () => {
    const onAction = vi.fn().mockRejectedValue(new Error('Editor unavailable'))
    render(<ResourceCardList rows={[{ resource: file }]} cwd="/work" onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }))
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Editor unavailable')
    expect(notice.previousElementSibling).toHaveTextContent('src')
    expect(notice.parentElement).toHaveClass('chat-resource-card-content')
  })
})

describe('resource actions', () => {
  it('dispatches the primary editor action with line through the timeline and surfaces errors', async () => {
    const action = vi.fn().mockRejectedValue(new Error('Editor unavailable'))
    render(<ChatTimeline items={[reply('`./src/main.ts:42`', [file])]} cwd="/work" working={false} onResourceAction={action} />)
    fireEvent.click(screen.getByRole('button', { name: './src/main.ts:42' }))
    expect(action).toHaveBeenCalledWith(file.path, 'editor', 42)
    expect(await screen.findByRole('status')).toHaveTextContent('Editor unavailable')
  })
  it('offers local actions via the menu, and copy writes the absolute path', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    render(<ResourceChip resource={file}>source</ResourceChip>)
    fireEvent.click(screen.getByRole('button', { name: 'Resource actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Open in editor' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open as tile' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(file.path))
  })
  it.each(['md', 'markdown'])('opens .%s in the editor and omits the tile action', async (extension) => {
    const markdown: ChatReplyResource = { ...file, ref: `./README.${extension}`, path: `/work/README.${extension}` }
    const action = vi.fn().mockResolvedValue({ ok: true, performed: 'editor' })
    expect(canTileResource(markdown.path)).toBe(false)
    expect(primaryResourceAction(markdown)).toBe('editor')
    render(<ResourceChip resource={markdown} onAction={action}>notes</ResourceChip>)
    fireEvent.click(screen.getByRole('button', { name: 'notes' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(markdown.path, 'editor', 42))
    fireEvent.click(screen.getByRole('button', { name: 'Resource actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Open in editor' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open as tile' })).toBeNull()
  })
  it('shows the performed open action when a tile request falls back', async () => {
    const tile: ChatReplyResource = { ...file, path: '/Users/me/page.html' }
    const action = vi.fn().mockResolvedValue({ ok: true, performed: 'open' })
    render(<ResourceChip resource={tile} onAction={action}>page</ResourceChip>)
    fireEvent.click(screen.getByRole('button', { name: 'page' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Open instead')
    expect(action).toHaveBeenCalledWith(tile.path, 'tile', 42)
  })
  it('supports right-click and tile actions for eligible files', async () => {
    const tile: ChatReplyResource = { ...file, ref: './page.html', path: '/work/page.html' }
    render(<ResourceChip resource={tile}>page</ResourceChip>)
    fireEvent.contextMenu(screen.getByText('page'))
    expect(await screen.findByRole('menuitem', { name: 'Open as tile' })).toBeInTheDocument()
  })
  it('missing references are struck through and only offer copy', async () => {
    const missing: ChatReplyResource = { ref: './gone', path: '/work/gone', missing: true }
    render(<ResourceChip resource={missing}>gone</ResourceChip>)
    expect(screen.getByText('gone').closest('[title]')).toHaveAttribute('title', '/work/gone — not found')
    expect(screen.getByText('gone').closest('.chat-resource-missing')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resource actions' }))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument()
  })
  it('remote chips and cards only copy and never invoke local actions', async () => {
    host.local = false
    const action = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<><ResourceChip resource={file} onAction={action}>source</ResourceChip><ResourceCardList rows={[{ resource: file }]} cwd="/work" onAction={action} /></>)
    expect(screen.queryByRole('button', { name: 'Open in editor' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.path))
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Resource actions' })[0])
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
  })
  it('file-change rows expose local editor and reveal actions without toggling details', async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, performed: 'reveal' })
    const item: ChatItem = { id: 'f', turnId: 't', kind: 'file_change', status: 'completed', createdAt: 1, updatedAt: 1, toolUseId: 'tool', toolName: 'Edit', path: file.path, additions: 1, deletions: 0, patch: '+ line' }
    render(<ChatTimeline items={[item]} cwd="/work" working={false} onResourceAction={action} />)
    fireEvent.click(screen.getByRole('button', { name: /Edited src\/main.ts/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(screen.getByText('+ line')).toBeInTheDocument()
    expect(action).toHaveBeenCalledWith(file.path, 'reveal', undefined)
  })
  it('abbreviates directories relative to cwd or home', () => {
    expect(resourceDirectory('/work/src/main.ts', '/work')).toBe('src')
    expect(resourceDirectory('/work/main.ts', '/work')).toBe('.')
    expect(resourceDirectory('/Users/me/Downloads/a.pdf', '/work')).toBe('~/Downloads')
  })
})
