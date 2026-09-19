import { act, render, screen } from '@testing-library/react-native'

import { buildAgentRows, groupAgentRows } from '../agents/selectors'
import {
  BRIEFS,
  CHECKING_STATUS,
  DONE_STATUS,
  NEEDS_INPUT_STATUS,
  SNAPSHOT,
  USAGE,
  WORKING_STATUS,
} from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { AttentionList } from './AttentionList'

const rows = buildAgentRows({
  statuses: {
    '%14': NEEDS_INPUT_STATUS,
    '%20': WORKING_STATUS,
    '%30': CHECKING_STATUS,
    '%40': DONE_STATUS,
  },
  snapshot: SNAPSHOT,
  briefs: BRIEFS,
})

async function renderList(): Promise<void> {
  render(
    <ThemeProvider>
      <AttentionList groups={groupAgentRows(rows)} usage={USAGE} />
    </ThemeProvider>,
  )
  // Let the persisted theme read settle so the tree is stable before asserting.
  await act(async () => undefined)
}

describe('the attention list', () => {
  it('heads each group the way the mockup does', async () => {
    await renderList()
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
    expect(screen.getByText('WORKING')).toBeTruthy()
    expect(screen.getByText('DONE')).toBeTruthy()
    expect(screen.queryByText('IDLE')).toBeNull()
  })

  it('shows the tmux session, provider chip and pending question', async () => {
    await renderList()
    expect(screen.getByText('commando')).toBeTruthy()
    expect(screen.getByText('Which auth flow should the companion use?')).toBeTruthy()
    expect(screen.getByText('Question · 3 options · window island')).toBeTruthy()
    // Two provider chips plus the usage tile for each of Claude and Codex.
    expect(screen.getAllByText('Claude')).toHaveLength(3)
    expect(screen.getAllByText('Codex')).toHaveLength(2)
    expect(screen.getByText('OpenCode')).toBeTruthy()
  })

  it('renders todo progress for the working agent', async () => {
    await renderList()
    expect(screen.getByText('4/7 tasks')).toBeTruthy()
  })

  it('shows a usage tile per available provider and hides the unavailable one', async () => {
    await renderList()
    expect(screen.getByText('58% left')).toBeTruthy()
    expect(screen.getByText('91% left')).toBeTruthy()
    expect(screen.getByText('weekly')).toBeTruthy()
    expect(screen.queryByText('No usage endpoint on this plan')).toBeNull()
  })

  it('labels each row for assistive tech', async () => {
    await renderList()
    expect(
      screen.getByLabelText('commando: Which auth flow should the companion use?'),
    ).toBeTruthy()
  })
})
