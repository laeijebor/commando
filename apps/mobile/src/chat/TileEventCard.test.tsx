import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { tileEventMarker, withTileEvents, type ChatAutofixEvent, type ChatTileEvent } from '@commando/chat-tile-events'

import { ThemeProvider } from '../theme'
import { ChatTimeline } from './ChatTimeline'
import { loadedTileEvents } from './ChatView'
import { item } from './testing'

const opened: ChatTileEvent = { id: 'open-1', kind: 'opened', paneId: '%7', webPaneId: 'wp-canvas', source: 'canvas', title: 'Layout study', fileName: 'canvas.json', at: 1_000 }
const sent: ChatTileEvent = {
  id: 'sent-1', kind: 'sent', paneId: '%7', webPaneId: 'wp-plan', source: 'redline', fileName: 'plan.html', at: 5_000,
  status: 'collected', collectedAt: 6_000, build: true,
  items: [
    { kind: 'answer', question: 'Which layout?', answer: 'Quiet', note: 'More room for code' },
    { kind: 'comment', target: 'button “Save”', comment: 'Make this primary' },
  ],
}
const autofix: ChatAutofixEvent = {
  id: 'fix-1', kind: 'autofix', paneId: '%7', at: 7_000, repo: 'me/app', number: 12, url: 'https://github.com/me/app/pull/12',
  round: 2, maxRounds: 3, failingChecks: ['typecheck'], comments: [
    { author: 'bot', body: '<!-- state -->\n## Fix the lint', url: 'https://x' },
    { author: 'reviewer', body: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].join('\n'), url: 'https://y' },
  ],
}

function renderTimeline(onOpenTile = jest.fn(), openTileIds: ReadonlySet<string> = new Set(['wp-canvas', 'wp-plan'])) {
  // The prompt Commando typed for the sent card ends with its marker, so the card replaces it.
  const pushed = item('user_message', { id: 'pushed', text: `Here are my answers…\n${tileEventMarker(['sent-1'])}`, createdAt: 5_000 })
  const items = withTileEvents([item('user_message', { id: 'first', text: 'Start', createdAt: 500 }), pushed], [opened, sent, autofix], undefined)
  render(<ThemeProvider><ChatTimeline baseUrl="http://studio" cwd="/tmp" items={items} onOpenTile={onOpenTile} openTileIds={openTileIds} working={false} /></ThemeProvider>)
  return onOpenTile
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

it('shows redline, canvas and auto-fix cards instead of the prompt Commando typed', async () => {
  const onOpenTile = renderTimeline()
  await act(async () => undefined)
  expect(screen.queryByText(/Here are my answers/)).toBeNull()
  expect(screen.getAllByTestId('tile-event-card')).toHaveLength(2)
  expect(screen.getByText('Collected')).toBeTruthy()
  expect(screen.getByText('1 answer, 1 comment · build')).toBeTruthy()

  fireEvent.press(screen.getByLabelText('Open canvas Layout study'))
  expect(onOpenTile).toHaveBeenCalledWith('wp-canvas')

  fireEvent.press(screen.getByText('plan.html'))
  expect(screen.getByText('Quiet')).toBeTruthy()
  expect(screen.getByText('More room for code')).toBeTruthy()
  expect(screen.getByText('Make this primary')).toBeTruthy()
  fireEvent.press(screen.getByText('Open page'))
  expect(onOpenTile).toHaveBeenLastCalledWith('wp-plan')

  fireEvent.press(screen.getByText('app#12'))
  expect(screen.getByText('typecheck')).toBeTruthy()
  expect(screen.getByText('Fix the lint')).toBeTruthy()
  expect(screen.getByLabelText("View reviewer's comment on GitHub")).toBeTruthy()
  fireEvent.press(screen.getByText('Show more'))
  expect(screen.getByText('Show less')).toBeTruthy()
})

it('offers no Open for a tile that has closed', async () => {
  renderTimeline(jest.fn(), new Set())
  await act(async () => undefined)
  expect(screen.queryByLabelText('Open canvas Layout study')).toBeNull()
})

describe('cards in a bounded history', () => {
  const firstLoaded = item('user_message', { id: 'loaded', text: 'Later', createdAt: 4_000 })
  it('keeps every card when the whole chat is loaded', () => {
    expect(loadedTileEvents([firstLoaded], [opened, sent], 0)).toEqual([opened, sent])
  })
  it('drops cards from before the loaded turns unless a loaded message carries them', () => {
    const pushed = item('user_message', { id: 'pushed', text: `Answers\n${tileEventMarker(['early'])}`, createdAt: 4_500 })
    const early: ChatTileEvent = { ...sent, id: 'early', at: 3_900 }
    expect(loadedTileEvents([firstLoaded, pushed], [opened, early, sent], 40)).toEqual([early, sent])
    expect(loadedTileEvents([], [opened], 40)).toEqual([])
  })
})
