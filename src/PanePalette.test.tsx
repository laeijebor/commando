// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanePaletteMenu, panePaletteEntries } from './PanePalette'

afterEach(cleanup)

describe('pane palette entries', () => {
  it('offers MCP servers only on chat panes, and explains when they cannot open', () => {
    expect(panePaletteEntries(undefined).map((entry) => entry.screen)).toEqual(['conversations'])
    const claude = { provider: 'claude', providerLabel: 'Claude', hostConnected: true, takesMcp: true }
    expect(panePaletteEntries(claude)[1]).toMatchObject({ screen: 'mcp' })
    expect(panePaletteEntries(claude)[1]!.unavailable).toBeUndefined()
    expect(panePaletteEntries({ ...claude, provider: 'codex', providerLabel: 'Codex' })[1]!.unavailable).toBe('Not available for Codex chats yet')
    expect(panePaletteEntries({ ...claude, hostConnected: false })[1]!.unavailable).toMatch(/disconnected/)
    expect(panePaletteEntries({ ...claude, takesMcp: false })[1]!.unavailable).toMatch(/Restart this chat/)
  })
})

describe('PanePaletteMenu', () => {
  const claude = panePaletteEntries({ provider: 'claude', providerLabel: 'Claude', hostConnected: true, takesMcp: true })

  it('filters by typing and opens the match with Enter', () => {
    const onOpen = vi.fn()
    render(<PanePaletteMenu entries={claude} onOpen={onOpen} onClose={() => {}} />)
    const input = screen.getByRole('textbox', { name: 'Search pane actions' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'mcp' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('mcp')
  })

  it('moves with the arrows and will not open an unavailable entry', () => {
    const onOpen = vi.fn()
    const entries = panePaletteEntries({ provider: 'codex', providerLabel: 'Codex', hostConnected: true, takesMcp: true })
    render(<PanePaletteMenu entries={entries} onOpen={onOpen} onClose={() => {}} />)
    const input = screen.getByRole('textbox', { name: 'Search pane actions' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /MCP servers/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Not available for Codex chats yet')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: /MCP servers/ }))
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('conversations')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<PanePaletteMenu entries={claude} onOpen={() => {}} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search pane actions' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
