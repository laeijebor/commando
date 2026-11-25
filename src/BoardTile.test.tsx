// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardView } from '../shared/board'
import type { SessionBrief } from '../shared/protocol'
import { BoardTile } from './BoardTile'
import { boardThumbPath, publishBoardChange, publishBoardRefresh, type BoardsApiClient } from './boardsApi'
import { boardPlaced } from './BoardGeometry'
import { HostProvider } from './HostContext'

const brief: SessionBrief = {
  targetId: 'b7b81000-1111-4111-8111-00c04fd430c8', paneId: '%12', sessionId: '$1', sessionName: 'work', headline: 'Build the board', headlineSource: 'agent', state: 'working', updates: [], updatedAt: 1,
  tasks: [{ id: 'a', content: 'Map artifacts', status: 'completed', priority: 'high' }, { id: 'b', content: 'Build UI', status: 'in_progress', priority: 'high' }],
  references: [{ kind: 'feature_flag', value: 'board' }],
}
const fixture: BoardView = {
  targetId: brief.targetId!, rev: 1,
  items: [
    { key: 'canvas:/spec', title: 'Design canvas', kind: 'canvas', source: 'agent', ref: { path: '/spec', manifest: 'canvas.json' }, state: 'closed', addedAt: 10, updatedAt: 10, origin: { at: 10, agentSession: { provider: 'claude', id: 'conversation-1' } }, caption: 'Layout choices' },
    { key: 'url:https://example.com', title: 'Reference docs', kind: 'link', source: 'auto', ref: { url: 'https://example.com' }, state: 'open', addedAt: 30, updatedAt: 30 },
    { key: 'file:/tmp/proof.png', title: 'Proof screenshot', kind: 'screenshot', source: 'user', ref: { path: '/tmp/proof.png' }, state: 'snapshot', addedAt: 20, updatedAt: 20 },
  ], groups: [{ id: 'spec', title: 'Spec', by: 'agent', tone: 'accent', x: 0, y: 0, w: 480, h: 250 }], placements: { 'canvas:/spec': { group: 'spec', x: 12, y: 40 } }, links: [],
}
function setup(initial = fixture) {
  let server = structuredClone(initial)
  const api: BoardsApiClient = {
    get: vi.fn(async () => structuredClone(server)),
    place: vi.fn(async (_target, key, placement) => { server = { ...boardPlaced(server, key, placement), rev: server.rev + 1 }; return structuredClone(server) }),
    patch: vi.fn(async (_target, key, patch) => { server = { ...server, rev: server.rev + 1, items: server.items.map((item) => item.key === key ? { ...item, ...patch } : item) } }),
    remove: vi.fn(async (_target, key) => { server = { ...server, rev: server.rev + 1, items: server.items.filter((item) => item.key !== key) } }),
    revive: vi.fn(async () => ({ webPaneId: 'w-revived' })), reveal: vi.fn(async () => {}),
  }
  return { api, props: { brief, paneLabel: 'api', boardApi: api, revealInFinder: true }, update: (next: BoardView) => { server = next } }
}
const showByType = () => fireEvent.click(screen.getByRole('button', { name: 'By type' }))
const openItem = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Quick look: ${title}` }))

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('BoardTile', () => {
  it('shows the brief, tasks, default Board view and groups without embedding live frames', async () => {
    const { props, api } = setup()
    const { container } = render(<BoardTile {...props} />)
    expect(screen.getByLabelText('Brief strip')).toHaveTextContent('Build the board')
    expect(screen.getByLabelText('Brief strip')).toHaveTextContent('1/2 tasks')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByLabelText('Group: Spec')).toHaveTextContent('placed by agent')
    expect(api.get).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('.board-details')).toHaveAttribute('hidden')
  })
  it('persists view choice by target and host, tolerating unavailable storage', async () => {
    const { props } = setup()
    const first = render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas')
    showByType()
    expect(localStorage.getItem(`commando.board.local:${brief.targetId}.view`)).toBe('type')
    first.unmount()
    render(<BoardTile {...props} />)
    expect(screen.getByRole('button', { name: 'By type' })).toHaveAttribute('aria-pressed', 'true')
    await screen.findByLabelText('Canvases & redlines & guides')
  })
  it('lists only unplaced items newest first and searches titles, captions and URLs', async () => {
    const { props } = setup()
    render(<BoardTile {...props} />)
    const inbox = await screen.findByLabelText('Unplaced inbox')
    expect(within(inbox).getAllByRole('button').map((node) => node.getAttribute('aria-label'))).toEqual(['Quick look: Reference docs', 'Quick look: Proof screenshot'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search board' }), { target: { value: 'layout' } })
    expect(screen.getByRole('button', { name: 'Quick look: Design canvas' })).toBeInTheDocument()
    expect(within(inbox).queryByRole('button')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search board' }), { target: { value: 'example.com' } })
    expect(within(inbox).getAllByRole('button')).toHaveLength(1)
  })
  it('shows type counts and state chips and applies type and closed filters', async () => {
    const { props } = setup()
    render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas'); showByType()
    const filters = screen.getByRole('group', { name: 'Filter by type' })
    expect(within(filters).getByRole('button', { name: 'All 3' })).toBeInTheDocument()
    expect(within(filters).getByRole('button', { name: 'Canvases & redlines & guides 1' })).toBeInTheDocument()
    expect(within(filters).getByRole('button', { name: 'Pull requests 0' })).toBeInTheDocument()
    expect(screen.getByText('Closed (revive)')).toBeInTheDocument()
    fireEvent.click(within(filters).getByRole('button', { name: 'Links 1' }))
    expect(screen.queryByRole('button', { name: 'Quick look: Design canvas' })).toBeNull()
    fireEvent.click(within(filters).getByRole('button', { name: 'Only closed' }))
    expect(screen.getByText('No matching items.')).toBeInTheDocument()
    expect(within(filters).getByRole('button', { name: 'All 1' })).toBeInTheDocument()
  })
  it('opens the unchanged worklog, edits the original note store and preserves hidden attention', async () => {
    const { props } = setup(), attention = vi.fn()
    const { rerender, container } = render(<BoardTile {...props} onAttentionChange={attention} />)
    await screen.findByLabelText('Board canvas')
    rerender(<BoardTile {...props} onAttentionChange={attention} brief={{ ...brief, updates: [{ id: 'new', paneId: '%12', kind: 'check', text: 'Verified', source: 'agent', createdAt: 2 }] }} />)
    await waitFor(() => expect(attention).toHaveBeenLastCalledWith('%12', true, false))
    fireEvent.click(screen.getByRole('button', { name: 'My notes' }))
    const note = screen.getByRole('textbox', { name: 'Note for api' })
    fireEvent.change(note, { target: { value: 'Remember this decision' } })
    expect(JSON.parse(localStorage.getItem(`commando.pane-worklog.${brief.targetId}`)!)).toMatchObject({ note: 'Remember this decision' })
    expect(container.querySelectorAll('.pane-worklog')).toHaveLength(1)
    expect(screen.getByLabelText('Worklog for api')).toHaveTextContent('Verified')
    expect(screen.getByLabelText('Worklog for api')).toHaveTextContent('Map artifacts')
    await waitFor(() => expect(attention).toHaveBeenLastCalledWith('%12', false, false))
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(container.querySelector('.board-details')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Terms · 1' }))
    expect(screen.getByLabelText('Important terms for api')).toHaveTextContent('board')
  })
  it('refetches only newer revisions for this target/host and defers hidden changes until show', async () => {
    const { props, api, update } = setup()
    const tile = render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas')
    act(() => { publishBoardChange({ targetId: brief.targetId!, rev: 1, host: 'local' }); publishBoardChange({ targetId: 'other', rev: 10, host: 'local' }); publishBoardChange({ targetId: brief.targetId!, rev: 10, host: 'remote' }) })
    expect(api.get).toHaveBeenCalledTimes(1)
    update({ ...fixture, rev: 2 })
    act(() => publishBoardChange({ targetId: brief.targetId!, rev: 2, host: 'local' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    tile.rerender(<BoardTile {...props} visible={false} />)
    update({ ...fixture, rev: 3 })
    act(() => publishBoardChange({ targetId: brief.targetId!, rev: 3, host: 'local' }))
    expect(api.get).toHaveBeenCalledTimes(2)
    tile.rerender(<BoardTile {...props} visible />)
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3))
    act(() => publishBoardRefresh('local'))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4))
    tile.unmount()
    act(() => publishBoardChange({ targetId: brief.targetId!, rev: 4, host: 'local' }))
    expect(api.get).toHaveBeenCalledTimes(4)
  })
  it('does not fetch before the mounted tab becomes visible', async () => {
    const { props, api } = setup()
    const tile = render(<BoardTile {...props} visible={false} />)
    expect(api.get).not.toHaveBeenCalled()
    tile.rerender(<BoardTile {...props} visible />)
    await screen.findByLabelText('Board canvas')
    expect(api.get).toHaveBeenCalledOnce()
  })
  it('places an inbox item into a group with an optimistic update', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600, x: 0, y: 0, toJSON() {} })
    const { props, api } = setup()
    const { container } = render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas')
    let finish!: (board: BoardView) => void
    vi.mocked(api.place).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const stage = container.querySelector('.board-canvas')!
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Quick look: Reference docs' }), { button: 0, clientX: 850, clientY: 100 })
    fireEvent.pointerMove(stage, { clientX: 150, clientY: 120 })
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 120 })
    expect(api.place).toHaveBeenCalledWith(brief.targetId, 'url:https://example.com', { group: 'spec' })
    expect(within(screen.getByLabelText('Unplaced inbox')).queryByRole('button', { name: 'Quick look: Reference docs' })).toBeNull()
    act(() => finish(boardPlaced(fixture, 'url:https://example.com', { group: 'spec' })))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })
  it('snaps free placement to 10px and rolls back failed drops', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600, x: 0, y: 0, toJSON() {} })
    const { props, api } = setup()
    vi.mocked(api.place).mockRejectedValue(new Error('Placement failed'))
    const { container } = render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas')
    const stage = container.querySelector('.board-canvas')!
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Quick look: Reference docs' }), { button: 0, clientX: 850, clientY: 100 })
    fireEvent.pointerMove(stage, { clientX: 650, clientY: 350 })
    fireEvent.pointerUp(stage, { clientX: 650, clientY: 350 })
    expect(api.place).toHaveBeenCalledWith(brief.targetId, 'url:https://example.com', { x: 630, y: 330, fixed: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('Placement failed')
    expect(within(screen.getByLabelText('Unplaced inbox')).getByRole('button', { name: 'Quick look: Reference docs' })).toBeInTheDocument()
  })
  it('renders cached PR titles and status using existing PR badges', async () => {
    const item = { ...fixture.items[0], key: 'pr:acme/app#42', title: 'Fallback PR', kind: 'pr' as const, ref: { pr: { repo: 'acme/app', number: 42 } } }
    const { props } = setup({ ...fixture, items: [item], placements: {} })
    render(<BoardTile {...props} panePrs={{ targetId: brief.targetId!, totalCount: 1, fetchedAt: 1, truncated: false, pullRequests: [{ repo: 'acme/app', number: 42, title: 'Fresh PR title', url: 'https://github.com/acme/app/pull/42', state: 'open', isDraft: false, createdAt: '', updatedAt: '', additions: 12, deletions: 2, checks: null, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: 'approved' }] }} />)
    await screen.findByLabelText('Board canvas'); showByType()
    expect(screen.getByRole('button', { name: 'Quick look: Fresh PR title' })).toHaveTextContent('+12')
    expect(screen.getByText('approved')).toBeInTheDocument()
  })
  it('uses lazy 320/960 host-aware thumbnails and replaces broken images with kind placeholders', async () => {
    localStorage.setItem('commando.active-host', 'build-host')
    const item = { ...fixture.items[0], thumb: { hash: 'a'.repeat(64), w: 960, h: 600 } }
    const { props } = setup({ ...fixture, items: [item] })
    const { container } = render(<HostProvider><BoardTile {...props} token="owner" /></HostProvider>)
    await screen.findByLabelText('Board canvas')
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('loading', 'lazy'); expect(img).toHaveAttribute('decoding', 'async')
    expect(img.getAttribute('srcset')).toContain(`/h/build-host${boardThumbPath(item.thumb.hash, 960)}?token=owner 960w`)
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.board-placeholder')).toHaveTextContent('Canvas')
  })
  it('culls distant cards and changes detail at zoom thresholds using one world transform', async () => {
    const near = { ...fixture.items[0], thumb: { hash: 'b'.repeat(64), w: 960, h: 600 } }
    const far = { ...near, key: 'canvas:/far', title: 'Distant artifact' }
    const { props } = setup({ ...fixture, items: [near, far], placements: { ...fixture.placements, [far.key]: { x: 20000, y: 20000 } } })
    const { container } = render(<BoardTile {...props} />)
    const viewport = await screen.findByLabelText('Board canvas')
    const world = container.querySelector<HTMLElement>('.board-world')!
    expect(screen.queryByRole('button', { name: 'Quick look: Distant artifact' })).toBeNull()
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 80, clientX: 100, clientY: 100 })
    expect(world).toHaveClass('lod-thumbnail')
    expect(world.querySelector('img')).not.toHaveAttribute('srcset')
    expect(world.querySelector('.board-state')).toBeNull()
    expect(world.style.transform).toContain('scale(0.449')
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 100, clientX: 100, clientY: 100 })
    expect(world).toHaveClass('lod-groups')
    expect(world.querySelector('img')).toBeNull()
    expect(world.querySelector('.board-group')).toHaveTextContent('Spec')
  })
  it('renders compact Recent, counts and tasks when the tile is narrower than 420px', async () => {
    vi.stubGlobal('ResizeObserver', class { constructor(private cb: ResizeObserverCallback) {} observe() { this.cb([], this as unknown as ResizeObserver) } disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 600, left: 0, right: 400, top: 0, bottom: 600, x: 0, y: 0, toJSON() {} })
    const { props } = setup()
    const { container } = render(<BoardTile {...props} />)
    expect(await screen.findByText('Recent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open board ↗' })).toBeDisabled()
    expect(screen.getByText('Widen this tile to open the board.')).toBeInTheDocument()
    expect(container.querySelector('.board-filmstrip')?.children).toHaveLength(3)
    expect(container.querySelector('.board-compact-tasks')).toHaveTextContent('Build UI')
    expect(screen.queryByLabelText('Board canvas')).toBeNull()
  })
})

describe('Board quick look', () => {
  it('revives, reveals, copies and pins from quick look; removal requires confirmation', async () => {
    const { props, api } = setup()
    const copy = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas')
    openItem('Design canvas')
    let dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('conversation-1')
    expect(dialog).toHaveTextContent('Layout choices')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal in Finder' }))
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith(brief.targetId, 'canvas:/spec'))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Copy path' })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('/spec'))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Pin' })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pin' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(brief.targetId, 'canvas:/spec', { pinned: true }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Unpin' })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen in a tile' }))
    await waitFor(() => expect(api.revive).toHaveBeenCalledWith(brief.targetId, 'canvas:/spec', '%12'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    openItem('Design canvas'); dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from board' }))
    expect(api.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm removal' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(brief.targetId, 'canvas:/spec'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('reveals a returned file path through the item route after revive', async () => {
    const { props, api } = setup()
    vi.mocked(api.revive).mockResolvedValue({ path: '/tmp/proof.png' })
    render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas'); openItem('Proof screenshot')
    fireEvent.click(screen.getByRole('button', { name: 'Reopen in a tile' }))
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith(brief.targetId, 'file:/tmp/proof.png'))
  })
  it('hides Reveal when the host lacks the capability, and Escape restores focus', async () => {
    const { props, api } = setup()
    render(<BoardTile {...props} revealInFinder={false} />)
    await screen.findByLabelText('Board canvas'); openItem('Proof screenshot')
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reopen in a tile' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Quick look: Proof screenshot' })).toHaveFocus()
    expect(api.reveal).not.toHaveBeenCalled()
  })
  it('reverts a failed pin and shows the error inside quick look', async () => {
    const { props, api } = setup()
    vi.mocked(api.patch).mockRejectedValue(new Error('Unable to save pin'))
    render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas'); openItem('Design canvas')
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Unable to save pin')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pin' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull()
  })
  it('reports reveal errors and keeps quick look available', async () => {
    const { props, api } = setup()
    vi.mocked(api.reveal).mockRejectedValue(new Error('This host cannot reveal files'))
    render(<BoardTile {...props} />)
    await screen.findByLabelText('Board canvas'); openItem('Design canvas')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This host cannot reveal files')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
