// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfilesResponse } from '../shared/agent-profiles'
import type { AgentProfilesApi } from './agentProfilesApi'
import { SettingsView, type CommanderProfileSetting } from './SettingsView'

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

function setup(overrides: Partial<AgentProfilesApi> = {}, commander?: CommanderProfileSetting) {
  const api = {
    list: vi.fn(async () => response()),
    updateClaude: vi.fn(async () => {}),
    addClaude: vi.fn(async () => '/Users/leo/.claudey'),
    loginClaude: vi.fn(async () => ({ created: { sessionId: '$9', windowId: '@9', paneId: '%9', targetId: 't' } })),
    ...overrides,
  } as AgentProfilesApi
  const onOpenPane = vi.fn()
  render(<SettingsView api={api} onOpenPane={onOpenPane} {...(commander ? { commander } : {})} />)
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

  describe('Commander profile', () => {
    it("shows Commander's profile and switches it after you confirm closing the old session", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
      const onSwitch = vi.fn(async () => {})
      setup({}, { open: true, onSwitch })
      expect(await screen.findByText('It is on the default login (no profile).', { exact: false })).toBeInTheDocument()
      const select = screen.getByRole('combobox', { name: 'Commander profile' })
      expect(select).toHaveValue('')
      expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Default login (no profile)', 'claude (hidden) · not logged in', 'Work', 'claudep'])
      const button = screen.getByRole('button', { name: 'Switch Commander' })
      expect(button).toBeDisabled()
      fireEvent.change(select, { target: { value: '/Users/leo/.claude' } })
      expect(screen.getByText("claude isn't logged in, so Commander would fail to reply. Log it in above first.")).toBeInTheDocument()
      fireEvent.change(select, { target: { value: '/Users/leo/.claudew' } })
      fireEvent.click(button)
      expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('This closes the current Commander session, and any other panes in it, then starts a new Commander on Work.'))
      expect(onSwitch).not.toHaveBeenCalled()
      fireEvent.click(button)
      await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('/Users/leo/.claudew'))
    })

    it('starts Commander on the default login when none is open, and shows a failure', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const onSwitch = vi.fn(async () => { throw new Error('tmux refused') })
      setup({}, { configDir: '/Users/leo/.claudew', open: false, onSwitch })
      expect(await screen.findByText('Work', { selector: 'strong' })).toBeInTheDocument()
      fireEvent.change(screen.getByRole('combobox', { name: 'Commander profile' }), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: 'Start Commander' }))
      expect(window.confirm).toHaveBeenCalledWith('Start Commander on the default login?')
      await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(null))
      expect(await screen.findByRole('alert')).toHaveTextContent('tmux refused')
    })
  })
})
