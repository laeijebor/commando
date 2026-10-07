// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrStackComposer } from './PrStackComposer'
import { PrStackPanel } from './PrStackPanel'
import { createPrsApi, type PrSummary } from './prsApi'
import type { PrStack } from '../shared/pr-stacks'

afterEach(cleanup)
const stack: PrStack = { number: 7, baseRefName: 'main', open: true, pullRequests: [
  { number: 10, state: 'merged', isDraft: false, headRefName: 'models', url: 'https://github.com/acme/widgets/pull/10' },
  { number: 20, state: 'open', isDraft: false, headRefName: 'api', url: 'https://github.com/acme/widgets/pull/20' },
] }
const prs = [
  { number: 10, title: 'Models', state: 'open', headRefName: 'models', baseRefName: 'main', stack: { number: 7, position: 1, size: 2, baseRefName: 'main' } },
  { number: 20, title: 'API', state: 'open', headRefName: 'api', baseRefName: 'models', stack: { number: 7, position: 2, size: 2, baseRefName: 'main' } },
] as PrSummary[]
function setup() {
  const api = { ...createPrsApi(''), linkStack: vi.fn().mockResolvedValue(stack), createStackedPr: vi.fn().mockResolvedValue({ pullRequest: { number: 30, url: 'https://github.com/acme/widgets/pull/30' }, stack }), stack: vi.fn().mockResolvedValue(stack) }
  const onRefresh = vi.fn().mockResolvedValue(undefined)
  return { api, onRefresh }
}

describe('native PR stack UI', () => {
  it('blocks duplicate submits and reports busy state until the write completes', async () => {
    const { api, onRefresh } = setup()
    let finish!: (value: PrStack) => void
    api.linkStack.mockImplementation(() => new Promise<PrStack>((resolve) => { finish = resolve }))
    const onBusyChange = vi.fn()
    render(<PrStackComposer repo="acme/widgets" prs={prs} api={api} onBusyChange={onBusyChange} onRefresh={onRefresh} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('PR numbers · bottom to top'), { target: { value: '10, 20' } })
    const submit = screen.getByRole('button', { name: 'Link stack on GitHub' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(api.linkStack).toHaveBeenCalledTimes(1)
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    finish(stack)
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false))
  })
  it('links explicit bottom-to-top numbers and does not repeat a successful write on refresh failure', async () => {
    const { api, onRefresh } = setup()
    onRefresh.mockRejectedValue(new Error('Offline'))
    render(<PrStackComposer repo="acme/widgets" prs={prs} api={api} onRefresh={onRefresh} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('PR numbers · bottom to top'), { target: { value: '#10, #20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link stack on GitHub' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Stack #7 saved')
    expect(api.linkStack).toHaveBeenCalledExactlyOnceWith('acme/widgets', [10, 20])
    expect(screen.getByRole('alert')).toHaveTextContent('Saved on GitHub')
    expect(screen.queryByRole('button', { name: 'Link stack on GitHub' })).not.toBeInTheDocument()
  })

  it('rejects duplicates locally, and displays preview errors without losing the form', async () => {
    const { api, onRefresh } = setup()
    api.linkStack.mockRejectedValue(new Error('Stacked PRs preview is unavailable'))
    render(<PrStackComposer repo="acme/widgets" prs={prs} api={api} onRefresh={onRefresh} onClose={vi.fn()} />)
    const input = screen.getByLabelText('PR numbers · bottom to top')
    fireEvent.change(input, { target: { value: '10, 10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link stack on GitHub' }))
    expect(api.linkStack).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('distinct')
    fireEvent.change(input, { target: { value: '10 20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link stack on GitHub' }))
    expect(await screen.findByText('Stacked PRs preview is unavailable')).toBeInTheDocument()
    expect(input).toHaveValue('10 20')
  })

  it('creates above the top parent, defaults to draft, and retains partial success', async () => {
    const { api, onRefresh } = setup()
    api.createStackedPr.mockResolvedValue({ pullRequest: { number: 30, url: 'https://github.com/acme/widgets/pull/30' }, stack: null, warning: 'PR #30 was created, but stack linking could not be confirmed.' })
    render(<PrStackComposer repo="acme/widgets" prs={prs} api={api} paneId="%7" onRefresh={onRefresh} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'New PR on top' }))
    expect(screen.queryByRole('option', { name: '#10 · Models' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Parent PR'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Already-pushed branch'), { target: { value: 'ui' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'UI' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Next layer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create stacked PR' }))
    expect(await screen.findByRole('link', { name: 'PR #30 created' })).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/30')
    expect(api.createStackedPr).toHaveBeenCalledExactlyOnceWith('acme/widgets', 20, { head: 'ui', title: 'UI', body: 'Next layer', draft: true }, '%7')
    expect(screen.getByRole('status')).toHaveTextContent('could not be confirmed')
    expect(screen.queryByRole('button', { name: 'Create stacked PR' })).not.toBeInTheDocument()
  })

  it('loads all stack layers, marks this PR, and discards stale stack responses on repo change', async () => {
    const { api } = setup()
    const { container, rerender } = render(<PrStackPanel repo="acme/widgets" pr={prs[1]} api={api} />)
    expect(await screen.findByRole('link', { name: '#10 models' })).toHaveAttribute('href', stack.pullRequests[0].url)
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('#20 api')
    expect(api.stack).toHaveBeenCalledWith('acme/widgets', 7)
    let resolve!: (value: PrStack) => void
    api.stack.mockImplementation(() => new Promise<PrStack>((done) => { resolve = done }))
    rerender(<PrStackPanel repo="acme/other" pr={prs[1]} api={api} />)
    expect(screen.queryByRole('link', { name: '#10 models' })).not.toBeInTheDocument()
    rerender(<PrStackPanel repo="acme/other" pr={{ ...prs[1], stack: null }} api={api} />)
    resolve(stack)
    await waitFor(() => expect(screen.getByText(/not in a native GitHub stack/)).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: '#10 models' })).not.toBeInTheDocument()
  })
})
