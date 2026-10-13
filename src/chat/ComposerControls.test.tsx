// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSessionInfo } from '../../shared/agent-chat'
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
