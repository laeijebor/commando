// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CursorCloudAgent, CursorCloudAgentsResponse } from '../shared/cursor-cloud-agents'
import { CursorCloudAgentsSection } from './CursorCloudAgentsSection'
import { CursorCloudAgentsStore, type CursorCloudAgentsApi } from './cursorCloudAgents'

afterEach(cleanup)
const agent: CursorCloudAgent = { agentId: 'bc-12345678', name: 'Fix layout', lastModified: Date.now() - 120_000,
  repoUrl: 'https://github.com/acme/app', status: 'running', branch: 'fix/layout', prUrl: 'https://github.com/acme/app/pull/1',
  webUrl: 'https://cursor.com/agents/bc-12345678', startedInCommando: false }
function fixture(patch: Partial<CursorCloudAgentsResponse> = {}) {
  const api = { list: vi.fn<CursorCloudAgentsApi['list']>().mockResolvedValue({ login: 'ok', agents: [agent], more: false, ...patch }),
    open: vi.fn<CursorCloudAgentsApi['open']>().mockResolvedValue('%9') }
  const store = new CursorCloudAgentsStore(api)
  const focus = vi.fn()
  render(<CursorCloudAgentsSection store={store} onFocusPane={focus} />)
  return { api, store, focus }
}
describe('CursorCloudAgentsSection', () => {
  it('shows the nine most recent agents by default and toggles all fifty without refetching', async () => {
    const agents = Array.from({ length: 50 }, (_, index) => ({ ...agent, agentId: `bc-${index}`, name: `Agent ${index}`, lastModified: index }))
    const { api } = fixture({ agents })
    const toggle = await screen.findByRole('button', { name: 'Show all (50)' })
    const region = screen.getByRole('region', { name: 'Cursor cloud agents' })
    expect(within(region).getAllByRole('article')).toHaveLength(9)
    expect(within(region).getAllByRole('article')[0]).toHaveTextContent('Agent 49')
    expect(screen.getByText('Agent 41')).toBeInTheDocument()
    expect(screen.queryByText('Agent 40')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(within(region).getAllByRole('article')).toHaveLength(50)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(within(region).getAllByRole('article')).toHaveLength(9)
    expect(api.list).toHaveBeenCalledOnce()
  })
  it('renders rows, status, timestamps, provenance, branch and provider links', async () => {
    fixture({ more: true, agents: [{ ...agent, environment: 'App Dev' }] })
    expect(await screen.findByText('Fix layout')).toBeInTheDocument()
    expect(screen.getByText('App Dev')).toBeInTheDocument()
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('2m ago')).toBeInTheDocument()
    expect(screen.getByText('Started elsewhere')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'acme/app' })).toHaveAttribute('href', agent.repoUrl)
    expect(screen.getByRole('link', { name: 'fix/layout' })).toHaveAttribute('href', 'https://github.com/acme/app/tree/fix%2Flayout')
    expect(screen.getByRole('link', { name: 'PR ↗' })).toHaveAttribute('href', agent.prUrl)
    expect(screen.getByRole('link', { name: /Open on cursor.com/ })).toHaveAttribute('href', agent.webUrl)
    expect(screen.getByText(/More are available on cursor.com/)).toBeInTheDocument()
  })
  it('opens chat and focuses its pane, then changes the action to Go to chat', async () => {
    const { api, focus } = fixture()
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))
    await waitFor(() => expect(focus).toHaveBeenCalledWith('%9'))
    expect(api.open).toHaveBeenCalledWith(agent.agentId)
    fireEvent.click(screen.getByRole('button', { name: 'Go to chat' }))
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(2))
    expect(api.open).toHaveBeenCalledTimes(2)
  })
  it('checks a cached pane with the daemon before focusing, and supports manual refresh', async () => {
    const { api, focus } = fixture({ agents: [{ ...agent, openPaneId: '%4', startedInCommando: true }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Go to chat' }))
    // The cached %4 has closed; the daemon reopens the chat in %9 and that pane is focused.
    await waitFor(() => expect(focus).toHaveBeenCalledWith('%9'))
    expect(api.open).toHaveBeenCalledWith(agent.agentId)
    expect(focus).not.toHaveBeenCalledWith('%4')
    expect(screen.queryByText('Started elsewhere')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(true))
  })
  it('shows login, empty and error states without crashing', async () => {
    fixture({ login: 'required', agents: [] })
    expect(await screen.findByText('Log in to Cursor from a Cursor chat to see your cloud agents.')).toBeInTheDocument()
    cleanup()
    fixture({ agents: [] })
    expect(await screen.findByText('No Cursor cloud agents yet.')).toBeInTheDocument()
    cleanup()
    fixture({ agents: [], error: 'Unable to load agents' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load agents')
  })
  it('shows open errors inline', async () => {
    const { api, focus } = fixture()
    api.open.mockRejectedValue(new Error('No local checkout of acme/app is open in Commando.'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No local checkout')
    expect(focus).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open chat' })).toBeEnabled()
  })
  it('renders every status label including unknown', async () => {
    fixture({ agents: [undefined, 'finished', 'error', 'cancelled'].map((status, i) => ({ ...agent, agentId: `bc-${i}`, status: status as CursorCloudAgent['status'] })) })
    for (const label of ['Unknown', 'Done', 'Failed', 'Stopped']) expect(await screen.findByText(label)).toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'Cursor cloud agents' })
    expect(within(region).getAllByRole('article')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /Show all|Show less/ })).not.toBeInTheDocument()
  })
})
