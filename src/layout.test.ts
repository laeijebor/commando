import { describe, expect, it } from 'vitest'

import type { CommandoSnapshot } from '../shared/protocol'
import {
  defaultGroupsForSession,
  getPanePlacement,
  moveItem,
  reconcileGroupsForSession,
} from './layout'

describe('getPanePlacement', () => {
  it('keeps the first two panes full width in two-full-two-halves', () => {
    const spans = Array.from({ length: 4 }, (_, index) =>
      getPanePlacement('two-full-two-halves', index, 4).columnSpan,
    )

    expect(spans).toEqual([12, 12, 6, 6])
  })

  it('makes only the first pane full width in full-then-halves', () => {
    const spans = Array.from({ length: 5 }, (_, index) =>
      getPanePlacement('full-then-halves', index, 5).columnSpan,
    )

    expect(spans).toEqual([12, 6, 6, 6, 6])
  })

  it('gives the lead pane two rows when a stack is available', () => {
    expect(getPanePlacement('lead-and-stack', 0, 4)).toEqual({
      columnSpan: 8,
      rowSpan: 2,
    })
    expect(getPanePlacement('lead-and-stack', 1, 4)).toEqual({
      columnSpan: 4,
      rowSpan: 1,
    })
  })
})

describe('moveItem', () => {
  it('reorders without mutating the source list', () => {
    const source = ['%1', '%2', '%3']

    expect(moveItem(source, 2, 0)).toEqual(['%3', '%1', '%2'])
    expect(source).toEqual(['%1', '%2', '%3'])
  })

  it('returns the same list for an inaccessible move', () => {
    const source = ['%1']

    expect(moveItem(source, 0, 1)).toBe(source)
  })
})

describe('defaultGroupsForSession', () => {
  it('creates daemon-safe group ids from tmux window ids', () => {
    const snapshot: CommandoSnapshot = {
      revision: 1,
      capturedAt: 1,
      sessions: [{
        id: '$1',
        name: 'work',
        attached: true,
        activeWindowId: '@2',
        windowIds: ['@2'],
      }],
      windows: [{
        id: '@2',
        index: 0,
        sessionId: '$1',
        name: 'editor',
        active: true,
        paneIds: ['%3'],
      }],
      panes: [],
    }

    expect(defaultGroupsForSession(snapshot, '$1')[0]?.id).toBe('window-2')
  })

  it('reconciles saved order with panes and windows added or removed in tmux', () => {
    const snapshot: CommandoSnapshot = {
      revision: 2,
      capturedAt: 2,
      sessions: [{
        id: '$1',
        name: 'work',
        attached: true,
        activeWindowId: '@2',
        windowIds: ['@2', '@4'],
      }],
      windows: [
        {
          id: '@2',
          index: 0,
          sessionId: '$1',
          name: 'editor',
          active: true,
          paneIds: ['%1', '%3'],
        },
        {
          id: '@4',
          index: 1,
          sessionId: '$1',
          name: 'server',
          active: false,
          paneIds: ['%4'],
        },
      ],
      panes: [],
    }
    const saved = [{
      id: 'window-2',
      name: 'Custom editor',
      sessionId: '$1',
      windowId: '@2',
      paneIds: ['%2', '%1'],
      layout: 'two-full-two-halves' as const,
    }]

    const groups = reconcileGroupsForSession(snapshot, '$1', saved)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      name: 'Custom editor',
      paneIds: ['%1', '%3'],
      layout: 'two-full-two-halves',
    })
    expect(groups[1]).toMatchObject({ windowId: '@4', paneIds: ['%4'] })
  })
})
