import { describe, expect, it } from 'vitest'

import type { CommandoSnapshot } from '../shared/protocol'
import {
  defaultGroupsForSession,
  moveItem,
  presetLayoutSpec,
  reconcileGroupsForSession,
  resolveActiveGroup,
} from './layout'

describe('presetLayoutSpec', () => {
  it('keeps the first two panes full width in two-full-two-halves', () => {
    expect(presetLayoutSpec('two-full-two-halves', ['%1', '%2', '%3', '%4'])).toMatchObject({
      kind: 'split',
      direction: 'column',
      children: [
        { kind: 'pane', paneId: '%1' },
        { kind: 'pane', paneId: '%2' },
        {
          kind: 'split',
          direction: 'row',
          children: [
            { kind: 'pane', paneId: '%3' },
            { kind: 'pane', paneId: '%4' },
          ],
        },
      ],
    })
  })

  it('pairs the lead pane with a stack in lead-and-stack', () => {
    expect(presetLayoutSpec('lead-and-stack', ['%1', '%2', '%3'])).toMatchObject({
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%1' },
        {
          kind: 'split',
          direction: 'column',
          children: [
            { kind: 'pane', paneId: '%2' },
            { kind: 'pane', paneId: '%3' },
          ],
        },
      ],
    })
  })

  it('chunks equal-grid into rows of three', () => {
    expect(presetLayoutSpec('equal-grid', ['%1', '%2', '%3', '%4', '%5'])).toMatchObject({
      kind: 'split',
      direction: 'column',
      children: [
        { kind: 'split', direction: 'row' },
        { kind: 'split', direction: 'row' },
      ],
    })
    expect(presetLayoutSpec('equal-grid', ['%1'])).toMatchObject({ kind: 'pane', paneId: '%1' })
    expect(presetLayoutSpec('equal-grid', [])).toBeNull()
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
        layout: 'dbde,80x24,0,0,3',
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
          layout: 'dbde,161x24,0,0{80x24,0,0,1,80x24,81,0,3}',
          paneIds: ['%1', '%3'],
        },
        {
          id: '@4',
          index: 1,
          sessionId: '$1',
          name: 'server',
          active: false,
          layout: 'dbde,80x24,0,0,4',
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
    }]

    const groups = reconcileGroupsForSession(snapshot, '$1', saved)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      name: 'Custom editor',
      paneIds: ['%1', '%3'],
    })
    expect(groups[1]).toMatchObject({ windowId: '@4', paneIds: ['%4'] })
  })
})

describe('resolveActiveGroup', () => {
  const group = (windowId: string) => ({
    id: `window-${windowId.slice(1)}`,
    name: windowId,
    sessionId: '$1',
    windowId,
    paneIds: [],
  })
  const groups = [group('@1'), group('@2'), group('@3')]

  it('prefers the selected tab window', () => {
    expect(resolveActiveGroup(groups, '@2', '@3')?.windowId).toBe('@2')
  })

  it('falls back to the session active window when the tab window is gone', () => {
    expect(resolveActiveGroup(groups, '@9', '@3')?.windowId).toBe('@3')
  })

  it('falls back to the first group when neither window exists', () => {
    expect(resolveActiveGroup(groups, '@9', '@8')?.windowId).toBe('@1')
    expect(resolveActiveGroup(groups, undefined, undefined)?.windowId).toBe('@1')
  })

  it('returns undefined for an empty session', () => {
    expect(resolveActiveGroup([], '@1', '@1')).toBeUndefined()
  })
})
