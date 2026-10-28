// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionNamingResponse } from '../shared/session-naming'
import { namingModelOptions, SessionNamingSection } from './SessionNamingSettings'
import type { SessionNamingApi } from './sessionNamingApi'

afterEach(cleanup)

const catalogs = {
  codex: { models: [{ value: 'gpt-6-luna', displayName: 'GPT-6-Luna' }, { value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }], updatedAt: 1 },
  'claude:/h/.claudep': { models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku 5.5' }], updatedAt: 1 },
}
const profiles = [{ name: 'claudep', configDir: '/h/.claudep', label: 'Personal', status: { state: 'logged-in' as const } }]
const response = (change: Partial<SessionNamingResponse> = {}): SessionNamingResponse => ({
  settings: { mode: 'naming-model', namingModel: { provider: 'codex', model: 'gpt-6-luna' }, timeoutSeconds: 10 },
  status: { state: 'available' },
  label: 'GPT-6-Luna',
  ...change,
})

describe('Session naming settings', () => {
  it('lists Codex and each Claude profile’s models, keeping the chosen one even when no list has it', () => {
    expect(namingModelOptions(catalogs, profiles, { provider: 'codex', model: 'gpt-6-luna' }).map((option) => option.label)).toEqual(['GPT-6-Luna · Codex', 'GPT-6.1-Sol · Codex', 'Haiku 5.5 · Claude (Personal)'])
    expect(namingModelOptions({}, [], { provider: 'codex', model: 'gpt-6-luna' }).map((option) => option.label)).toEqual(['gpt-6-luna · Codex'])
  })

  it('switches model and mode, shows a failure with Try again, and saves the wait', async () => {
    const api: SessionNamingApi = {
      suggest: vi.fn(),
      describe: vi.fn(async () => response({ status: { state: 'unavailable', since: Date.UTC(2026, 9, 28, 14, 2), reason: 'Not logged in', canRetry: true } })),
      update: vi.fn(async (change) => response({ settings: { ...response().settings, ...change } })),
      retry: vi.fn(async () => response()),
    }
    render(<SessionNamingSection api={api} loadModels={async () => catalogs} profiles={profiles} />)
    expect(await screen.findByText(/Unavailable on this machine since .*: Not logged in\. Using the chat's model/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.retry).toHaveBeenCalledOnce())
    expect(await screen.findByText('Available')).toBeInTheDocument()

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
    fireEvent.change(screen.getByLabelText('Naming model'), { target: { value: 'claude|/h/.claudep|haiku' } })
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ mode: 'naming-model', namingModel: { provider: 'claude', model: 'haiku', configDir: '/h/.claudep' } }))
    fireEvent.click(screen.getByLabelText('Use the model selected for the chat'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ mode: 'chat-model' }))

    const wait = screen.getByLabelText('Seconds to wait for a name')
    fireEvent.change(wait, { target: { value: '99' } })
    fireEvent.blur(wait)
    expect(wait).toHaveValue(10)
    fireEvent.change(wait, { target: { value: '15' } })
    fireEvent.keyDown(wait, { key: 'Enter' })
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ timeoutSeconds: 15 }))
  })
})
