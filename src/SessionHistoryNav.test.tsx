// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionHistoryNav, sessionHistoryKey, useSessionHistory } from './SessionHistoryNav'
import { parseHistory, serialiseHistory, type SessionHistory } from './sessionHistory'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'

const sessions = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }, { id: 'd', name: 'Delta' }]
const select = vi.fn<(id: string) => void>()
function Harness({ host = 'local', live = sessions }: { host?: string; live?: typeof sessions }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [area, setArea] = useState('workspace')
  const history = useSessionHistory(host, live, selected, (id) => { select(id); setSelected(id); setArea('workspace') })
  return <>
    <SessionHistoryNav {...history} />
    <output>{selected}:{area}</output>
    {live.map((session) => <button key={session.id} onClick={() => setSelected(session.id)}>Visit {session.name}</button>)}
    <button onClick={() => setArea('notes')}>Notes</button>
    <button onClick={() => setArea('pane')}>Other pane</button>
  </>
}
const visit = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Visit ${name}` }))
const stored = () => parseHistory(sessionStorage.getItem(sessionHistoryKey('local')))
const back = () => screen.getByRole('button', { name: /^Back/ })
const forward = () => screen.getByRole('button', { name: /^Forward/ })
const openMenu = () => { fireEvent.contextMenu(back()); return screen.getByRole('menu', { name: 'Recently viewed' }) }
const key = (value: string, modifiers = { metaKey: true }) => fireEvent.keyDown(window, { key: value, ...modifiers })

beforeEach(() => { sessionStorage.clear(); select.mockReset() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); sessionStorage.clear() })

describe('session history navigation', () => {
  it('records selected sessions, ignores areas and re-selection, steps once and branches', () => {
    render(<Harness />)
    expect(back()).toBeDisabled()
    expect(forward()).toBeDisabled()
    visit('Alpha'); visit('Beta'); visit('Beta'); visit('Gamma')
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Other pane' }))
    expect(stored().entries.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c'])
    fireEvent.click(back())
    expect(select).toHaveBeenLastCalledWith('b')
    expect(screen.getByRole('status')).toHaveTextContent('b:workspace')
    expect(stored().index).toBe(1)
    expect(forward()).toHaveAccessibleName('Forward to Gamma')
    fireEvent.click(forward())
    expect(stored().entries).toHaveLength(3)
    fireEvent.click(back()); visit('Delta')
    expect(stored().entries.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'd'])
    expect(forward()).toBeDisabled()
  })

  it('captures only unmodified meta brackets before terminal handlers and accepts native shortcuts', () => {
    render(<Harness />)
    visit('Alpha'); visit('Beta'); visit('Gamma')
    const terminal = vi.fn()
    const node = screen.getByRole('button', { name: 'Notes' })
    node.addEventListener('keydown', terminal)
    expect(fireEvent.keyDown(node, { key: '[', metaKey: true })).toBe(false)
    expect(terminal).not.toHaveBeenCalled()
    expect(stored().index).toBe(1)
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true, altKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, ctrlKey: true }]) {
      fireEvent.keyDown(node, { key: '[', ...modifiers })
    }
    expect(stored().index).toBe(1)
    fireEvent.keyDown(node, { key: '[', metaKey: true, repeat: true })
    expect(stored().index).toBe(1)
    act(() => { window.dispatchEvent(new CustomEvent(NATIVE_TERMINAL_SHORTCUT_EVENT, { detail: { key: '[' } })) })
    expect(stored().index).toBe(0)
    act(() => { window.dispatchEvent(new CustomEvent(NATIVE_TERMINAL_SHORTCUT_EVENT, { detail: { key: ']' } })) })
    expect(stored().index).toBe(1)
    expect(key(']')).toBe(false)
    expect(stored().index).toBe(2)
  })

  it('deduplicates side-button mouseup/auxclick pairs and supports auxclick alone', () => {
    render(<Harness />)
    visit('Alpha'); visit('Beta'); visit('Gamma')
    expect(fireEvent.mouseUp(window, { button: 3 })).toBe(false)
    expect(fireEvent(window, new MouseEvent('auxclick', { button: 3, cancelable: true }))).toBe(false)
    expect(stored().index).toBe(1)
    fireEvent.mouseUp(window, { button: 4 })
    fireEvent(window, new MouseEvent('auxclick', { button: 4, cancelable: true }))
    expect(stored().index).toBe(2)
    fireEvent(window, new MouseEvent('auxclick', { button: 3, cancelable: true }))
    expect(stored().index).toBe(1)
  })

  it('shows the whole newest-first trail with a current row; jumping preserves forward entries', () => {
    render(<Harness />)
    visit('Alpha'); visit('Beta'); visit('Gamma'); fireEvent.click(back())
    const menu = openMenu()
    expect(menu).toHaveAttribute('data-native-terminal-occluder', '')
    expect(within(menu).getByText('3 of 50')).toBeInTheDocument()
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Gamma, just now', 'Beta, current', 'Alpha, just now'])
    expect(rows[1]).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(rows[2])
    expect(stored().index).toBe(0)
    expect(stored().entries).toHaveLength(3)
    fireEvent.contextMenu(forward())
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Gamma, just now' }))
    expect(stored().index).toBe(2)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('skips deleted sessions, retains their last name, and supports menu keyboard navigation', () => {
    const view = render(<Harness />)
    visit('Alpha'); visit('Beta'); visit('Gamma')
    view.rerender(<Harness live={sessions.filter((session) => session.id !== 'b')} />)
    expect(back()).toHaveAccessibleName('Back to Alpha')
    const menu = openMenu()
    const gone = within(menu).getByRole('menuitemradio', { name: 'Beta, closed' })
    expect(gone).toBeDisabled()
    expect(gone).toHaveClass('gone')
    expect(menu).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(stored().index).toBe(0)
    expect(forward()).toHaveAccessibleName('Forward to Gamma')
    fireEvent.contextMenu(forward())
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(stored().index).toBe(2)
    openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(back()).toHaveFocus()
    openMenu()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(back())
    expect(stored().index).toBe(0)
    view.rerender(<Harness live={sessions.filter((session) => session.id === 'a')} />)
    expect(forward()).toBeDisabled()
    expect(back()).toHaveAccessibleName('Back')
  })

  it('opens after a 450ms hold, suppresses its click, and cancels short/cancelled holds', () => {
    vi.useFakeTimers()
    // jsdom otherwise creates a generic Event without pointer button information.
    vi.stubGlobal('PointerEvent', MouseEvent)
    render(<Harness />)
    visit('Alpha'); visit('Beta')
    fireEvent.pointerDown(back(), { button: 0 })
    act(() => vi.advanceTimersByTime(449))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerUp(back()); fireEvent.click(back())
    expect(stored().index).toBe(1)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.pointerDown(back(), { button: 0 }); fireEvent.pointerCancel(back())
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.pointerDown(back(), { button: 0 }); fireEvent.pointerUp(back()); fireEvent.click(back())
    expect(stored().index).toBe(0)
    vi.unstubAllGlobals()
  })

  it('delays and dismisses custom tooltips, showing target and shortcut', () => {
    vi.useFakeTimers()
    render(<Harness />)
    visit('Alpha'); visit('Beta')
    fireEvent.mouseEnter(back())
    act(() => vi.advanceTimersByTime(499))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Back to Alpha⌘[hold for list')
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-native-terminal-occluder', '')
    fireEvent.mouseLeave(back())
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.click(back()); fireEvent.mouseEnter(forward())
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Forward to Beta⌘]hold for list')
    fireEvent.contextMenu(forward())
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('restores the current index after reload and keeps local and remote trails separate', () => {
    let view = render(<Harness />)
    visit('Alpha'); visit('Beta'); visit('Gamma'); fireEvent.click(back())
    view.unmount()
    view = render(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('b:workspace')
    expect(stored().entries).toHaveLength(3)
    expect(stored().index).toBe(1)
    view.unmount()
    view = render(<Harness host="remote-1" />)
    expect(back()).toBeDisabled()
    visit('Delta')
    expect(parseHistory(sessionStorage.getItem(sessionHistoryKey('remote-1'))).entries[0].sessionId).toBe('d')
    expect(stored().entries.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c'])
    view.unmount()
    render(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('b:workspace')
  })

  it('refreshes live names and formats relative times', () => {
    const history: SessionHistory = { index: 2, entries: [
      { sessionId: 'a', name: 'Old name', at: Date.now() - 2 * 3600000 },
      { sessionId: 'b', name: 'Beta', at: Date.now() - 4 * 60000 },
      { sessionId: 'c', name: 'Gamma', at: Date.now() },
    ] }
    sessionStorage.setItem(sessionHistoryKey('local'), serialiseHistory(history))
    render(<Harness />)
    const menu = openMenu()
    expect(within(menu).getByRole('menuitemradio', { name: 'Alpha, 2 hours ago' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: 'Beta, 4 minutes ago' })).toBeInTheDocument()
  })

  it('continues in memory when session storage is unavailable or junk', () => {
    sessionStorage.setItem(sessionHistoryKey('local'), 'junk')
    const view = render(<Harness />)
    expect(back()).toBeDisabled()
    view.unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<Harness />)
    visit('Alpha'); visit('Beta')
    fireEvent.click(back())
    expect(screen.getByRole('status')).toHaveTextContent('a:workspace')
    expect(forward()).toHaveAccessibleName('Forward to Beta')
  })
})
