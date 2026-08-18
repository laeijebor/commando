import { describe, expect, it, vi } from 'vitest'

import { parseStoredPaneTarget, TmuxPaneTargets } from './tmux-pane-targets.js'

const TARGET = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_TARGET = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'

describe('tmux pane targets', () => {
  it('reuses a valid target bound to its current pane', async () => {
    const persist = vi.fn()
    const targets = await new TmuxPaneTargets(persist).reconcile([
      { paneId: '%42', storedValue: `v1:%42:${TARGET}` },
    ])

    expect(targets.get('%42')).toBe(TARGET)
    expect(persist).not.toHaveBeenCalled()
  })

  it('replaces missing, malformed, and inherited values', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const generated = [TARGET, OTHER_TARGET]
    const targets = await new TmuxPaneTargets(persist, () => generated.shift()!).reconcile([
      { paneId: '%42', storedValue: '' },
      { paneId: '%43', storedValue: `v1:%42:${TARGET}` },
    ])

    expect([...targets]).toEqual([['%42', TARGET], ['%43', OTHER_TARGET]])
    expect(persist).toHaveBeenNthCalledWith(1, '%42', `v1:%42:${TARGET}`)
    expect(persist).toHaveBeenNthCalledWith(2, '%43', `v1:%43:${OTHER_TARGET}`)
  })

  it('repairs duplicate target ids rather than resolving ambiguously', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const generated = [
      '7ba7b810-9dad-41d1-80b4-00c04fd430c8',
      '8ba7b810-9dad-41d1-80b4-00c04fd430c8',
    ]
    const targets = await new TmuxPaneTargets(persist, () => generated.shift()!).reconcile([
      { paneId: '%42', storedValue: `v1:%42:${TARGET}` },
      { paneId: '%43', storedValue: `v1:%43:${TARGET}` },
    ])

    expect(new Set(targets.values()).size).toBe(2)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid owners and ids', () => {
    expect(parseStoredPaneTarget(`v1:%42:${TARGET}`, '%42')).toBe(TARGET)
    expect(parseStoredPaneTarget(`v1:%42:${TARGET}`, '%43')).toBeNull()
    expect(parseStoredPaneTarget('v1:%42:%99', '%42')).toBeNull()
  })
})
