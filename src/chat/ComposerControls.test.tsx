// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatModelOption, ChatProvider, ChatSessionInfo } from '../../shared/agent-chat'
import { ModelPicker, PermissionPicker } from './ComposerControls'

const models = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', efforts: ['low' as const, 'high' as const] },
  { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low' as const, 'high' as const] },
  { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
]
// A fresh chat: Claude has listed its models but not yet reported one (that comes with the first turn).
const fresh: ChatSessionInfo = { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 3, models, permissionMode: 'default' }

afterEach(cleanup)

describe('ModelPicker', () => {
  it('lets a fresh chat pick its model before the first message', async () => {
    const onConfigure = vi.fn()
    render(<ModelPicker session={fresh} disabled={false} onConfigure={onConfigure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5' }))
    expect(await screen.findByRole('menuitemradio', { name: /Default/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radiogroup', { name: 'Effort' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }))
    expect(onConfigure).toHaveBeenCalledWith({ model: 'sonnet' })
  })

  it('names the model behind a context-window variant a setting picked', () => {
    render(<ModelPicker session={{ ...fresh, model: 'claude-opus-5-5[1m]' }} disabled={false} onConfigure={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Opus 5.5' })).toBeInTheDocument()
  })

  it('names the default row when it does not say which model it runs', () => {
    render(<ModelPicker session={{ ...fresh, models: [{ value: 'default', displayName: 'Default' }] }} disabled={false} onConfigure={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument()
  })

  it('keeps the adjacent fast button and menu toggle in sync for supported models', async () => {
    const onConfigure = vi.fn()
    const fastModels = [{ ...models[1]!, supportsFast: true }, models[2]!]
    const view = render(<ModelPicker session={{ ...fresh, models: fastModels, selectedModel: 'opus' }} disabled={false} onConfigure={onConfigure} />)
    const fastButton = screen.getByRole('button', { name: 'Fast off' })
    expect(fastButton).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(fastButton)
    expect(onConfigure).toHaveBeenLastCalledWith({ fast: true })
    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5' }))
    const toggle = await screen.findByRole('menuitemcheckbox', { name: /Fast mode/ })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onConfigure).toHaveBeenCalledWith({ fast: true })
    view.rerender(<ModelPicker session={{ ...fresh, models: fastModels, selectedModel: 'opus', fast: true }} disabled={false} onConfigure={onConfigure} />)
    expect(screen.getByRole('button', { name: 'Opus 5.5' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fast on' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5' }))
    expect(await screen.findByRole('menuitemcheckbox', { name: /Fast mode/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fast mode/ }))
    expect(onConfigure).toHaveBeenLastCalledWith({ fast: false })
    fireEvent.click(screen.getByRole('button', { name: 'Fast on' }))
    expect(onConfigure).toHaveBeenLastCalledWith({ fast: false })
    view.rerender(<ModelPicker session={{ ...fresh, models: fastModels, selectedModel: 'opus', fast: true }} disabled onConfigure={onConfigure} />)
    expect(screen.getByRole('button', { name: 'Fast on' })).toBeDisabled()
    // A model without fast mode neither offers nor claims it.
    view.rerender(<ModelPicker session={{ ...fresh, models: fastModels, selectedModel: 'sonnet', fast: true }} disabled={false} onConfigure={onConfigure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sonnet 5.5' }))
    expect(screen.queryByRole('menuitemcheckbox', { name: /Fast mode/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Fast (on|off)/ })).toBeNull()
  })

  it('shows nothing until Claude lists its models', () => {
    const { container } = render(<ModelPicker session={{ ...fresh, models: undefined }} disabled={false} onConfigure={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Codex model and permissions controls', () => {
  it('renders Codex reasoning efforts through the existing model picker', async () => {
    const onConfigure = vi.fn()
    render(<ModelPicker session={{ ...fresh, provider: 'codex', model: 'test-model', selectedModel: 'test-model', effort: 'high', models: [{ value: 'test-model', displayName: 'Codex model', efforts: ['low', 'high'] }] }} disabled={false} onConfigure={onConfigure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex model · High' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Low' }))
    expect(onConfigure).toHaveBeenCalledWith({ effort: 'low' })
  })
  it('offers workspace access, read only and explicitly enabled full access', async () => {
    render(<PermissionPicker session={{ ...fresh, provider: 'codex', bypassAllowed: true }} disabled={false} onConfigure={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace access' }))
    expect(await screen.findByRole('menuitemradio', { name: /Read only/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Full access/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /Accept edits|Auto/ })).not.toBeInTheDocument()
  })
})

describe('ModelPicker cross-provider handoff', () => {
  const providerModels: Partial<Record<ChatProvider, ChatModelOption[]>> = {
    cursor: [{ value: 'claude-4-sonnet', displayName: 'Claude 4 Sonnet' }],
    codex: [{ value: 'gpt-5.4', displayName: 'GPT-5.4' }],
  }

  it('groups other providers below current models and requires inline confirmation before handing off', async () => {
    const onHandoff = vi.fn(async () => {})
    render(<ModelPicker session={fresh} disabled={false} onConfigure={vi.fn()} providerModels={providerModels} onHandoff={onHandoff} />)

    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5' }))
    expect(await screen.findByText('Hand off to another provider')).toBeInTheDocument()
    // Excludes the current provider (Claude) from handoff targets.
    expect(screen.queryByRole('menu', { name: 'Hand off to Claude' })).toBeNull()
    expect(screen.getByRole('menu', { name: 'Hand off to Cursor' })).toBeInTheDocument()
    expect(screen.getByRole('menu', { name: 'Hand off to Codex' })).toBeInTheDocument()
    expect(screen.getByRole('menu', { name: 'Hand off to Muse' })).toBeInTheDocument()
    expect(screen.getByRole('menu', { name: 'Hand off to DeepSeek' })).toBeInTheDocument()

    // Clicking a target shows the confirmation strip without immediately handing off.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude 4 Sonnet' }))
    expect(onHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('handoff-confirm')).toHaveTextContent('Hand off to Cursor (Claude 4 Sonnet) in this worktree? Sends a brief of this chat.')

    // Cancelling dismisses the confirmation strip.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('handoff-confirm')).toBeNull()

    // Confirming invokes onHandoff with the chosen provider and model.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude 4 Sonnet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hand off' }))
    expect(onHandoff).toHaveBeenCalledWith({ provider: 'cursor', model: 'claude-4-sonnet' })
  })

  it('disables confirmation while a turn is running', async () => {
    const onHandoff = vi.fn(async () => {})
    render(<ModelPicker session={{ ...fresh, status: 'running' }} disabled={false} onConfigure={vi.fn()} providerModels={providerModels} onHandoff={onHandoff} />)

    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.4' }))
    expect(screen.getByText('Wait for the current turn to finish before handing off.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeDisabled()
    expect(onHandoff).not.toHaveBeenCalled()
  })
})
