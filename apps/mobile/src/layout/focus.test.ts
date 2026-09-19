import { buildAgentRows } from '../agents/selectors'
import {
  DONE_STATUS,
  NEEDS_INPUT_STATUS,
  SNAPSHOT,
  WORKING_STATUS,
} from '../testing/fixtures'
import { chooseFocusedPane } from './focus'

const rows = buildAgentRows({
  statuses: {
    [DONE_STATUS.paneId]: DONE_STATUS,
    [WORKING_STATUS.paneId]: WORKING_STATUS,
    [NEEDS_INPUT_STATUS.paneId]: NEEDS_INPUT_STATUS,
  },
  snapshot: SNAPSHOT,
})

describe('choosing the cockpit’s focused pane', () => {
  it('opens on the pane that needs the owner', () => {
    expect(chooseFocusedPane({ rows })).toBe(NEEDS_INPUT_STATUS.paneId)
  })

  it('falls back to a working pane when nothing needs answering', () => {
    const quiet = rows.filter((row) => row.group !== 'needs_you')
    expect(chooseFocusedPane({ rows: quiet })).toBe(WORKING_STATUS.paneId)
  })

  it('falls back to whatever is left when nothing is working either', () => {
    const done = rows.filter((row) => row.group === 'done')
    expect(chooseFocusedPane({ rows: done })).toBe(DONE_STATUS.paneId)
  })

  it('takes a pane from the snapshot when no agent reports at all', () => {
    expect(chooseFocusedPane({ rows: [], paneIds: ['%15', '%20'] })).toBe('%15')
    expect(chooseFocusedPane({ rows: [] })).toBeUndefined()
  })

  it('keeps the pane the owner picked, even when another one needs them', () => {
    expect(chooseFocusedPane({ rows, current: WORKING_STATUS.paneId }))
      .toBe(WORKING_STATUS.paneId)
  })

  it('keeps a picked pane that only the snapshot knows about', () => {
    expect(chooseFocusedPane({ rows, current: '%15', paneIds: ['%15'] })).toBe('%15')
  })

  it('re-picks when the focused pane has gone away', () => {
    expect(chooseFocusedPane({ rows, current: '%nope', paneIds: ['%14'] }))
      .toBe(NEEDS_INPUT_STATUS.paneId)
  })
})
