// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '../../shared/agent-chat'
import { tileEventMarker, withTileEvents, type ChatAutofixEvent } from '../../shared/chat-tile-events'
import { AutofixCard, readableComment } from './AutofixCard'
import { ChatTimeline } from './ChatTimeline'

afterEach(cleanup)

const event: ChatAutofixEvent = {
  id: 'te-af', kind: 'autofix', paneId: '%1', at: 0, repo: 'Save-All/Save-All', number: 28072,
  url: 'https://github.com/Save-All/Save-All/pull/28072', round: 2, maxRounds: 5, headSha: 'edd962830f5e',
  failingChecks: ['web / typecheck'],
  comments: [
    { author: 'chatgpt-codex-connector[bot]', body: '<!-- codex-review-state:v1 {"x":1} -->\n\n## Codex Review Summary\n\nOne finding.', url: 'https://github.com/c/1' },
    { author: 'reviewer', body: 'Handle the empty input', url: 'https://github.com/c/2' },
  ],
}

describe('AutofixCard', () => {
  it('summarises the round and expands to checks and readable comments', () => {
    const onOpenPr = vi.fn()
    render(<AutofixCard event={event} onOpenPr={onOpenPr} />)
    const toggle = screen.getByRole('button', { name: /Auto-fix · Save-All#28072/ })
    expect(toggle).toHaveTextContent('1 failing check, 2 comments')
    expect(toggle).toHaveTextContent('Round 2/5')
    fireEvent.click(toggle)
    expect(screen.getByText('web / typecheck')).toBeInTheDocument()
    expect(screen.getByText(/Codex Review Summary/)).toBeInTheDocument()
    expect(screen.queryByText(/codex-review-state/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }))
    expect(onOpenPr).toHaveBeenCalledWith('Save-All/Save-All', 28072, 'Checks')
  })

  it('shows merge conflicts the round told the agent about', () => {
    render(<AutofixCard event={{ ...event, comments: [], conflictsWith: 'feat/layer-1' }} />)
    const toggle = screen.getByRole('button', { name: /Auto-fix/ })
    expect(toggle).toHaveTextContent('1 failing check, merge conflicts')
    fireEvent.click(toggle)
    expect(screen.getByText('feat/layer-1')).toBeInTheDocument()
  })

  it('drops HTML comment markers from bot comments', () => {
    expect(readableComment('<!-- a -->\n<!-- b\nc -->\n\n\n\n## Hello\nworld #1')).toBe('Hello\nworld #1')
    // A lone delimiter in real feedback is text, not hidden state.
    expect(readableComment('Escape the `<!--` in header.html')).toBe('Escape the `<!--` in header.html')
  })
})

describe('ChatTimeline with an auto-fix prompt', () => {
  it('shows the tagged prompt as its card', () => {
    const pushed: ChatItem = { id: 'u1', kind: 'user_message', text: `Auto-fix CI & address comments for Save-All/Save-All#28072: …\n${tileEventMarker(['te-af'])}`, turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1 }
    render(<ChatTimeline items={withTileEvents([pushed], [event])} cwd="/tmp" working={false} />)
    expect(screen.getByTestId('autofix-card')).toHaveTextContent('Auto-fix · Save-All#28072')
    expect(screen.queryByText(/Auto-fix CI & address comments/)).not.toBeInTheDocument()
  })
})
