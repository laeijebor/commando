// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfilesResponse } from '../shared/agent-profiles'
import type { AgentProfilesApi } from './agentProfilesApi'
import { SettingsView } from './SettingsView'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const response = (): AgentProfilesResponse => ({
  claude: [
    { name: 'claude', configDir: '/Users/leo/.claude', hidden: true, status: { state: 'logged-out' } },
    { name: 'claudew', configDir: '/Users/leo/.claudew', label: 'Work', isDefault: true, hidden: false, status: { state: 'logged-in', email: 'leo@work.test', orgName: 'Gizmo', subscriptionType: 'team' } },
    { name: 'claudep', configDir: '/Users/leo/.claudep', hidden: false, status: { state: 'unknown', error: 'keychain locked' } },
  ],
  others: [
    { provider: 'codex', label: 'Codex', configDir: '/Users/leo/.codex', installed: true, state: 'logged-in', detail: 'Logged in using ChatGPT' },
    { provider: 'opencode', label: 'OpenCode', configDir: '/Users/leo/.config/opencode', installed: false, state: 'unknown', detail: 'Not installed on the daemon PATH' },
  ],
})

function setup(overrides: Partial<AgentProfilesApi> = {}) {
  const api = {
    list: vi.fn(async () => response()),
    updateClaude: vi.fn(async () => {}),
    addClaude: vi.fn(async () => '/Users/leo/.claudey'),
    loginClaude: vi.fn(async () => ({ created: { sessionId: '$9', windowId: '@9', paneId: '%9', targetId: 't' } })),
    ...overrides,
  } as AgentProfilesApi
  const onOpenPane = vi.fn()
  render(<SettingsView api={api} onOpenPane={onOpenPane} />)
  return { api, onOpenPane }
}
const row = (path: string) => screen.getAllByText(path).map((node) => node.closest('li')).find(Boolean) as HTMLElement

describe('SettingsView', () => {
  it("lists each Claude profile's label, folder and login, and the other agents read-only", async () => {
    setup()
    await screen.findByText('~/.claudew')
    expect(within(row('~/.claudew')).getByRole('textbox', { name: 'Label for ~/.claudew' })).toHaveValue('Work')
    expect(within(row('~/.claudew')).getByRole('status')).toHaveTextContent('Logged in as leo@work.test · Gizmo · team')
    expect(within(row('~/.claude')).getByRole('status')).toHaveTextContent('Not logged in')
    expect(within(row('~/.claudep')).getByRole('status')).toHaveTextContent("Couldn't check: keychain locked")
    expect(within(row('~/.claudew')).getByRole('radio', { name: 'Default' })).toBeChecked()
    // The default cannot be hidden, and a hidden profile cannot be the default.
    expect(within(row('~/.claudew')).getByRole('checkbox', { name: 'Show in pickers' })).toBeDisabled()
    expect(within(row('~/.claude')).getByRole('radio', { name: 'Default' })).toBeDisabled()
    expect(within(row('~/.claude')).getByRole('checkbox', { name: 'Show in pickers' })).not.toBeChecked()
    expect(within(row('~/.codex')).getByRole('status')).toHaveTextContent('Logged in using ChatGPT')
    expect(within(row('~/.config/opencode')).getByRole('status')).toHaveTextContent('Not installed on the daemon PATH')
    expect(within(row('~/.codex')).queryByRole('button')).toBeNull()
  })

  it('saves a label on blur, clearing it when emptied, and changes the default and visibility', async () => {
    const { api } = setup()
    const label = await screen.findByRole('textbox', { name: 'Label for ~/.claudep' })
    fireEvent.change(label, { target: { value: ' Personal ' } })
    fireEvent.blur(label)
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith({ configDir: '/Users/leo/.claudep', label: 'Personal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Label for ~/.claudew' }), { target: { value: '' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Label for ~/.claudew' }), { key: 'Enter' })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Label for ~/.claudew' }))
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith({ configDir: '/Users/leo/.claudew', label: null }))
    fireEvent.click(within(row('~/.claudep')).getByRole('radio', { name: 'Default' }))
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith({ configDir: '/Users/leo/.claudep', isDefault: true }))
    fireEvent.click(screen.getByRole('radio', { name: 'Default to the most recently used profile' }))
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith({ configDir: '/Users/leo/.claudew', isDefault: false }))
    fireEvent.click(within(row('~/.claude')).getByRole('checkbox', { name: 'Show in pickers' }))
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith({ configDir: '/Users/leo/.claude', hidden: false }))
  })

  it("shows a change at once and puts it back when the daemon refuses it", async () => {
    let refuse!: (error: Error) => void
    const { api } = setup({ updateClaude: vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject })) })
    const show = within(await screen.findByText('~/.claudep').then(() => row('~/.claudep'))).getByRole('checkbox', { name: 'Show in pickers' })
    fireEvent.click(show)
    expect(show).not.toBeChecked()
    refuse(new Error('At least one profile must stay in the pickers'))
    expect(await screen.findByRole('alert')).toHaveTextContent('At least one profile must stay in the pickers')
    await waitFor(() => expect(within(row('~/.claudep')).getByRole('checkbox', { name: 'Show in pickers' })).toBeChecked())
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('opens a login terminal and jumps to it', async () => {
    const { api, onOpenPane } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Log in to claudep' }))
    await waitFor(() => expect(onOpenPane).toHaveBeenCalledWith('%9'))
    expect(api.loginClaude).toHaveBeenCalledWith('/Users/leo/.claudep')
    expect(screen.getByRole('button', { name: 'Log in to Work' })).toHaveTextContent('Log in again')
  })

  it('adds a profile from a valid folder name and an optional label, and shows daemon errors', async () => {
    const { api } = setup({ addClaude: vi.fn().mockRejectedValueOnce(new Error('/Users/leo/.claudey already exists')).mockResolvedValue('/Users/leo/.claudey') })
    const name = await screen.findByRole('textbox', { name: 'Profile folder name' })
    const add = screen.getByRole('button', { name: 'Add profile' })
    fireEvent.change(name, { target: { value: 'bad name' } })
    expect(add).toBeDisabled()
    expect(screen.getByText('Use letters, digits, - or _.')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'y' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'New profile label' }), { target: { value: 'Spare' } })
    fireEvent.click(add)
    expect(await screen.findByRole('alert')).toHaveTextContent('/Users/leo/.claudey already exists')
    fireEvent.click(add)
    await waitFor(() => expect(name).toHaveValue(''))
    expect(api.addClaude).toHaveBeenLastCalledWith('y', 'Spare')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('asks the CLIs again when you check logins', async () => {
    const { api } = setup()
    await screen.findByText('~/.claudew')
    fireEvent.click(screen.getByRole('button', { name: 'Check logins' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(true))
  })
})
