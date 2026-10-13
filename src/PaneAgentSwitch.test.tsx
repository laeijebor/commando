// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol'
import { PaneAgentSwitch, paneChatHandoff } from './PaneAgentSwitch'

afterEach(cleanup)

describe('handoff switch-back eligibility', () => {
  const codex = { paneId: '%4', sessionId: 'codex-thread', provider: 'codex' as const }
  const legacy = new Set(['claude-session'])
  const status = (provider: AgentStatus['provider'], agentSessionId: string) => ({ provider, agentSessionId }) as AgentStatus

  it('offers Codex switch-back and labels it from the handoff before any live hook status', () => {
    const handoff = paneChatHandoff('%4', undefined, [codex], legacy)
    expect(handoff).toEqual(codex)
    const onChat = vi.fn()
    render(<PaneAgentSwitch mode="claude-code" provider={handoff?.provider} onChat={onChat} onClaudeCode={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Codex TUI' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(onChat).toHaveBeenCalledOnce()
    expect(paneChatHandoff('%5', undefined, [codex], legacy)).toBeUndefined()
  })

  it('preserves Claude eligibility for legacy entries and defaults their provider to Claude', () => {
    expect(paneChatHandoff('%4', status('claude', 'claude-session'), [], legacy)).toEqual({ sessionId: 'claude-session' })
    expect(paneChatHandoff('%4', status('codex', 'claude-session'), [], legacy)).toBeUndefined()
    expect(paneChatHandoff('%4', undefined, [{ paneId: '%4', sessionId: 'claude-session' }], legacy)).toBeUndefined()
    expect(paneChatHandoff('%4', status('claude', 'claude-session'), [{ sessionId: 'claude-session' }], legacy)).toEqual({ sessionId: 'claude-session' })
  })
})
