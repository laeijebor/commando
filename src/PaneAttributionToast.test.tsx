// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { PaneAttributionToast, usePaneAttribution } from './PaneAttributionToast'

afterEach(() => { cleanup(); vi.useRealTimers() })
const parent = { id: '%1', targetId: 'parent', sessionId: '$1' } as TmuxPane
const child = { id: '%2', targetId: 'child', sessionId: '$2', openedBy: 'parent' } as TmuxPane

describe('pane attribution', () => {
  it('ignores initial panes and shows newly appearing agent panes for six seconds', () => {
    vi.useFakeTimers()
    const { result } = renderHook(usePaneAttribution)
    act(() => result.current.observe([parent, child]))
    expect(result.current.visibleTargets.size).toBe(0)
    const newer = { ...child, id: '%3', targetId: 'new' }
    const ordinary = { ...child, id: '%4', targetId: 'ordinary', openedBy: undefined }
    act(() => result.current.observe([parent, child, newer, ordinary]))
    expect([...result.current.visibleTargets]).toEqual(['new'])
    act(() => vi.advanceTimersByTime(5_999))
    expect(result.current.visibleTargets.has('new')).toBe(true)
    act(() => result.current.observe([parent, newer]))
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.visibleTargets.size).toBe(0)
    act(() => result.current.observe([parent]))
    act(() => result.current.observe([parent, newer]))
    expect(result.current.visibleTargets.size).toBe(0)
  })
  it('uses the parent label in a native-terminal-aware status pill', () => {
    render(<PaneAttributionToast pane={child} snapshot={{ panes: [parent, child], sessions: [{ id: '$1', name: 'main', attached: false, activeWindowId: null, windowIds: [] }] }} statuses={{}} />)
    expect(screen.getByRole('status')).toHaveTextContent('main opened this chat')
    expect(screen.getByRole('status')).toHaveClass('pane-attribution-toast')
    expect(screen.getByRole('status')).toHaveAttribute('data-native-terminal-occluder', '')
  })
  it('recognizes delayed lineage within five seconds and starts the toast lifetime when lineage arrives', () => {
    vi.useFakeTimers()
    const { result } = renderHook(usePaneAttribution)
    act(() => result.current.observe([parent]))
    act(() => result.current.observe([parent, { ...child, openedBy: undefined }]))
    expect(result.current.visibleTargets.size).toBe(0)
    expect(result.current.isRecentTarget(child.targetId)).toBe(true)
    act(() => vi.advanceTimersByTime(5_000))
    act(() => result.current.observe([parent, child]))
    expect(result.current.visibleTargets.has(child.targetId)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.isRecentTarget(child.targetId)).toBe(false)
    act(() => result.current.observe([parent, child]))
    act(() => vi.advanceTimersByTime(5_999))
    expect(result.current.visibleTargets.size).toBe(0)
    act(() => result.current.observe([parent, child]))
    expect(result.current.visibleTargets.size).toBe(0)
  })
  it('ignores late lineage and lineage attached to initially loaded targets', () => {
    vi.useFakeTimers()
    const { result } = renderHook(usePaneAttribution)
    act(() => result.current.observe([{ ...parent, openedBy: undefined }]))
    act(() => result.current.observe([{ ...parent, openedBy: 'older' }, { ...child, openedBy: undefined }]))
    expect(result.current.visibleTargets.size).toBe(0)
    expect(result.current.isRecentTarget(parent.targetId)).toBe(false)
    act(() => vi.advanceTimersByTime(5_001))
    act(() => result.current.observe([parent, child]))
    expect(result.current.visibleTargets.size).toBe(0)
  })
})
