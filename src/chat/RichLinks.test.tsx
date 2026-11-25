// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatReplyResource } from '../../shared/agent-chat'
import { Markdown } from './ChatTimeline'
import { RichLinksContext, type RichLinkServices } from './RichLinks'
import { ResourceCardList, ResourceChip } from './ResourceChip'

const host = vi.hoisted(() => ({ local: true }))
vi.mock('../HostContext', () => ({ useHost: () => host }))
afterEach(() => { cleanup(); host.local = true; vi.unstubAllGlobals() })

const PR = 'https://github.com/acme/widgets/pull/12'
const ISSUE = 'https://linear.app/acme/issue/ENG-42/fix-the-login-loop'
function renderReply(text: string, services: RichLinkServices, resources?: ChatReplyResource[]) {
  return render(<RichLinksContext value={services}><Markdown text={text} {...(resources ? { resources } : {})} /></RichLinksContext>)
}

describe('PR links in replies', () => {
  it('shows a bare PR address as a chip with its title and state, opening Quick Look', async () => {
    const prSummary = vi.fn().mockResolvedValue({ title: 'feat: add thing', state: 'merged', author: 'leo' })
    const openPr = vi.fn()
    renderReply(`Opened ${PR}/files and [the PR](${PR}).`, { prSummary, openPr })
    const chips = await screen.findAllByRole('button', { name: /acme\/widgets#12.*feat: add thing.*Merged/ })
    expect(chips).toHaveLength(2)
    // One request for both chips of the same PR.
    expect(prSummary).toHaveBeenCalledTimes(1)
    expect(prSummary).toHaveBeenCalledWith('acme/widgets', 12)
    fireEvent.click(chips[0])
    expect(openPr).toHaveBeenCalledWith('acme/widgets', 12, 'Diff')
    fireEvent.click(chips[1])
    expect(openPr).toHaveBeenLastCalledWith('acme/widgets', 12, 'Description')
  })

  it('still shows owner/repo#n when GitHub is unavailable, and keeps the link text', async () => {
    const prSummary = vi.fn().mockRejectedValue(new Error('GitHub is off'))
    renderReply(`See [the login fix](${PR.replace('12', '13')}).`, { prSummary })
    await waitFor(() => expect(prSummary).toHaveBeenCalled())
    // Without Quick Look, the chip is a link to GitHub.
    const chip = await screen.findByRole('link', { name: /acme\/widgets#13.*the login fix/ })
    expect(chip).toHaveAttribute('href', PR.replace('12', '13'))
    expect(chip).toHaveAttribute('target', '_blank')
    expect(screen.queryByText('Open')).toBeNull()
  })

  it('offers Quick Look, GitHub and Copy link in its menu', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const openPr = vi.fn()
    renderReply(`${PR.replace('12', '14')}`, { openPr })
    fireEvent.click(screen.getByRole('button', { name: 'Link actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Quick Look' }))
    expect(openPr).toHaveBeenCalledWith('acme/widgets', 14, 'Description')
    fireEvent.click(screen.getByRole('button', { name: 'Link actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open on GitHub' }))
    expect(open).toHaveBeenCalledWith(PR.replace('12', '14'), '_blank', 'noopener,noreferrer')
    fireEvent.click(screen.getByRole('button', { name: 'Link actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PR.replace('12', '14')))
  })

  it('turns a list of PRs into cards with author and branch, and leaves other links alone', async () => {
    const prSummary = vi.fn(async (_repo: string, number: number) => ({ title: `PR ${number}`, state: number === 20 ? 'open' as const : 'draft' as const, author: 'leo', branch: `branch-${number}` }))
    const openPr = vi.fn()
    renderReply(`- ${PR.replace('12', '20')} — the API\n- ${PR.replace('12', '21')} — the UI\n\n[docs](https://example.com/pull/1)`, { prSummary, openPr })
    const list = screen.getByRole('list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    await waitFor(() => expect(rows[0]).toHaveTextContent('PR 20'))
    expect(rows[0]).toHaveTextContent('the API')
    expect(rows[0]).toHaveTextContent('acme/widgets#20 · leo · branch-20')
    expect(rows[0]).toHaveTextContent('Open')
    expect(rows[1]).toHaveTextContent('Draft')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Quick Look' }))
    expect(openPr).toHaveBeenCalledWith('acme/widgets', 21, 'Description')
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com/pull/1')
  })
})

describe('Linear links in replies', () => {
  it('shows the issue title, state and assignee, opening the issue in the browser', async () => {
    const linearIssue = vi.fn().mockResolvedValue({ identifier: 'ENG-42', title: 'Fix the login loop', url: ISSUE, state: { name: 'In Progress', color: '#f2c94c' }, assignee: 'Ada' })
    renderReply(`Tracked in ${ISSUE}. Not an issue: ENG-43.`, { linearIssue })
    const chip = await screen.findByRole('link', { name: /ENG-42.*Fix the login loop.*In Progress/ })
    expect(chip).toHaveAttribute('href', ISSUE)
    expect(linearIssue).toHaveBeenCalledWith(ISSUE)
    expect(screen.getByText(/Not an issue: ENG-43/)).toBeInTheDocument()
    expect(chip.querySelector('.chat-linear-dot')).toHaveStyle({ background: '#f2c94c' })
  })

  it('degrades to the identifier when Linear is not configured', () => {
    renderReply(`Tracked in ${ISSUE.replace('42', '44')}.`, {})
    expect(screen.getByRole('link', { name: 'ENG-44' })).toBeInTheDocument()
  })

  it('shows a list of issues as cards with the assignee', async () => {
    const linearIssue = vi.fn(async (url: string) => ({ identifier: url.includes('ENG-50') ? 'ENG-50' : 'ENG-51', title: 'An issue', url, assignee: 'Ada' }))
    renderReply('- https://linear.app/acme/issue/ENG-50\n- https://linear.app/acme/issue/ENG-51/slug', { linearIssue })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    await waitFor(() => expect(rows[0]).toHaveTextContent('ENG-50 · Ada'))
    expect(within(rows[1]).getByRole('link', { name: 'Linear' })).toHaveAttribute('href', 'https://linear.app/acme/issue/ENG-51/slug')
  })
})

describe('slides decks in replies', () => {
  const deck: ChatReplyResource = { ref: './talk', path: '/work/talk', kind: 'folder', entries: 4, deck: { folder: '/work/talk', manifest: 'deck.html', title: 'Launch plan', slides: 12, first: 'Why now' } }
  it('shows a deck as a slides chip and a lone deck list item as a slides card that presents', async () => {
    const onAction = vi.fn().mockResolvedValue({ ok: true, performed: 'slides', webPaneId: 'w-1' })
    const { container } = render(<Markdown text={'Deck: `./talk`\n\n- `./talk` — the launch talk'} resources={[deck]} />)
    expect(container.querySelector('.chat-resource-chip')).toHaveAttribute('title', 'Launch plan · 12 slides — /work/talk')
    const card = screen.getByRole('listitem')
    expect(card).toHaveTextContent('Launch plan')
    expect(card).toHaveTextContent('Why now')
    expect(card).toHaveTextContent('12 slides')
    expect(card).toHaveTextContent('the launch talk')
    expect(onAction).not.toHaveBeenCalled()
  })

  it('presents from the card, and opens the deck folder from a page in it', async () => {
    const onAction = vi.fn().mockResolvedValue({ ok: true, performed: 'slides', webPaneId: 'w-1' })
    render(<ResourceCardList cwd="/work" rows={[{ resource: deck }]} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('/work/talk', 'slides', undefined))
    cleanup()
    const page: ChatReplyResource = { ref: 'talk/onepager.html', path: '/work/talk/onepager.html', kind: 'file', deck: { ...deck.deck!, manifest: 'onepager.html' } }
    onAction.mockResolvedValue({ ok: true, performed: 'open' })
    render(<ResourceChip resource={page} onAction={onAction}>talk/onepager.html</ResourceChip>)
    fireEvent.click(screen.getByRole('button', { name: 'Resource actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder' }))
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith('/work/talk', 'open', undefined))
    fireEvent.click(screen.getByRole('button', { name: 'talk/onepager.html' }))
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith('/work/talk/onepager.html', 'slides', undefined))
  })

  it('only copies on a remote host', async () => {
    host.local = false
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onAction = vi.fn()
    render(<ResourceCardList cwd="/work" rows={[{ resource: deck }]} onAction={onAction} />)
    expect(screen.queryByRole('button', { name: 'Present' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/talk'))
    expect(onAction).not.toHaveBeenCalled()
  })
})
