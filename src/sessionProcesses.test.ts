import { describe, expect, it } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { sessionProcesses, sessionProcessesWarning } from './sessionProcesses'

const pane = (id: string, overrides: Partial<TmuxPane> = {}) => ({
  id, sessionId: '$1', index: 0, title: '', command: 'zsh', dead: false, ...overrides,
}) as TmuxPane

describe('sessionProcesses', () => {
  it('lists live panes in the session as chats or terminals, skipping dead panes and empty launchers', () => {
    const panes = [
      pane('%1', { title: 'Claude', chatTitle: 'Disk cleanup' }),
      pane('%2', { title: 'npm run dev' }),
      pane('%3', { dead: true }),
      pane('%4', { empty: true }),
      pane('%5', { sessionId: '$2' }),
    ]
    expect(sessionProcesses(panes, '$1', new Set(['%1']))).toEqual([
      { paneId: '%1', kind: 'chat', label: 'Disk cleanup' },
      { paneId: '%2', kind: 'terminal', label: 'npm run dev' },
    ])
  })

  it('falls back to the command and then the pane index for a label', () => {
    expect(sessionProcesses([pane('%1', { command: 'vim' }), pane('%2', { command: '', index: 3 })], '$1', new Set()).map(({ label }) => label))
      .toEqual(['vim', 'Pane 3'])
  })
})

describe('sessionProcessesWarning', () => {
  it('warns only when more than one process would stop', () => {
    expect(sessionProcessesWarning('work', [])).toBeUndefined()
    expect(sessionProcessesWarning('work', [{ paneId: '%1', kind: 'chat', label: 'Disk cleanup' }])).toBeUndefined()
    expect(sessionProcessesWarning('work', [
      { paneId: '%1', kind: 'chat', label: 'Disk cleanup' },
      { paneId: '%2', kind: 'terminal', label: 'npm run dev' },
    ])).toBe('“work” has 2 active processes, and all of them will stop:\n• Disk cleanup (chat)\n• npm run dev (terminal)')
  })
})
