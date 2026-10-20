import { EMPTY_HOST_STATE } from '../daemon/state'
import { SNAPSHOT, NEEDS_INPUT_STATUS } from '../testing/fixtures'
import { chatState } from '../chat/testing'
import { chatListDestination } from './chatListSelection'
const state = { ...EMPTY_HOST_STATE, snapshot: SNAPSHOT, agentStatuses: { '%14': NEEDS_INPUT_STATUS } }
it('routes terminal brokered questions to the answer flow', () => {
  expect(chatListDestination(state, {}, '%14')).toMatchObject({ kind: 'answer', row: { paneId: '%14', pendingQuestionCount: 1 } })
})
it('keeps structured chat requests inline and normal terminals in their pane', () => {
  expect(chatListDestination(state, { '%14': chatState() }, '%14')).toEqual({ kind: 'pane', paneId: '%14' })
  expect(chatListDestination(state, {}, '%15')).toEqual({ kind: 'pane', paneId: '%15' })
})
