import { describe, expect, it } from 'vitest'

import type { CommandoSnapshot } from '../shared/protocol.js'
import { snapshotsHaveSameState } from './snapshot-state.js'

const snapshot: CommandoSnapshot = {
  revision: 4,
  capturedAt: 100,
  sessions: [{
    id: '$1',
    name: 'commando',
    attached: true,
    activeWindowId: '@1',
    windowIds: ['@1'],
  }],
  windows: [{
    id: '@1',
    index: 0,
    sessionId: '$1',
    name: 'app',
    active: true,
    layout: 'layout-1',
    paneIds: ['%1'],
  }],
  panes: [{
    id: '%1',
    targetId: '550e8400-e29b-41d4-a716-446655440000',
    index: 0,
    windowId: '@1',
    sessionId: '$1',
    title: 'OpenCode',
    command: 'opencode',
    path: '/worktree',
    active: true,
    dead: false,
    width: 80,
    height: 24,
    cursorX: 0,
    cursorY: 0,
    alternateSavedX: 0,
    alternateSavedY: 0,
    alternateOn: false,
    cursorVisible: true,
    cursorShape: 'default',
    cursorBlinking: false,
    scrollRegionUpper: 0,
    scrollRegionLower: 23,
    wrapFlag: true,
    originFlag: false,
    insertFlag: false,
    keypadFlag: false,
    keypadCursorFlag: false,
    mouseAnyFlag: false,
    mouseSgrFlag: false,
    paneTabs: [],
  }],
  ports: [{ port: 4310, processName: 'node', sessionId: '$1', paneId: '%1' }],
}

describe('snapshotsHaveSameState', () => {
  it('ignores polling metadata', () => {
    expect(snapshotsHaveSameState(snapshot, {
      ...snapshot,
      revision: snapshot.revision + 1,
      capturedAt: snapshot.capturedAt + 1_000,
    })).toBe(true)
  })

  it('ignores terminal cursor movement and animated title frames', () => {
    const left = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0], title: '\u2802 Working' }],
    }
    const right = {
      ...snapshot,
      panes: [{
        ...snapshot.panes[0],
        title: '\u2810 Working',
        cursorX: 12,
        cursorY: 8,
        alternateSavedX: 4,
        alternateSavedY: 5,
      }],
    }

    expect(snapshotsHaveSameState(left, right)).toBe(true)
  })

  it.each([
    ['sessions', { ...snapshot, sessions: [{ ...snapshot.sessions[0], name: 'renamed' }] }],
    ['windows', { ...snapshot, windows: [{ ...snapshot.windows[0], layout: 'layout-2' }] }],
    ['pane titles', { ...snapshot, panes: [{ ...snapshot.panes[0], title: 'renamed' }] }],
    ['pane targets', { ...snapshot, panes: [{ ...snapshot.panes[0], targetId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' }] }],
    ['pane dimensions', { ...snapshot, panes: [{ ...snapshot.panes[0], width: 120 }] }],
    ['pane terminal modes', { ...snapshot, panes: [{ ...snapshot.panes[0], mouseAnyFlag: true }] }],
    ['ports', { ...snapshot, ports: [{ ...snapshot.ports[0], processName: 'vite' }] }],
  ] satisfies Array<[string, CommandoSnapshot]>)('detects changes to %s', (_collection, next) => {
    expect(snapshotsHaveSameState(snapshot, next)).toBe(false)
  })

  it('treats relationship ordering as semantic', () => {
    const secondWindow = {
      ...snapshot.windows[0],
      id: '@2',
      index: 1,
      paneIds: [],
    }
    const left = {
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], windowIds: ['@1', '@2'] }],
      windows: [snapshot.windows[0], secondWindow],
    }
    const right = {
      ...left,
      sessions: [{ ...snapshot.sessions[0], windowIds: ['@2', '@1'] }],
    }

    expect(snapshotsHaveSameState(left, right)).toBe(false)
  })
})
