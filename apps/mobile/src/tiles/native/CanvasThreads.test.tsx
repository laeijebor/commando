import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { CanvasThread } from '@commando/protocol'
import type { CanvasFrame } from '@commando/canvas-manifest'

import { ThemeProvider } from '../../theme'
import { frameCommentContext } from './frameComment'
import { CanvasThreadList, sortThreads } from './CanvasThreads'

const thread = (id: string, status: CanvasThread['status'], at: number, messages: CanvasThread['messages'] = [{ author: 'user', text: `Note ${id}`, at }]): CanvasThread => ({
  id, webPaneId: 'w1', frameId: 'home', point: { x: 0, y: 0 }, label: 'Composer', status, createdAt: at, messages,
})

const FRAME: CanvasFrame = { id: 'home', title: 'Home', src: 'home.html', x: 0, y: 0, w: 390, h: 844 } as CanvasFrame

describe('canvas threads', () => {
  it('puts open threads first, newest activity first', () => {
    expect(sortThreads([thread('a', 'resolved', 9), thread('b', 'open', 1), thread('c', 'open', 5)]).map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })

  it('shows the conversation, replies, resolves and folds resolved threads', async () => {
    const onReply = jest.fn(async () => undefined)
    const onStatus = jest.fn(async () => undefined)
    const onReveal = jest.fn()
    const open = thread('a', 'open', 2, [{ author: 'user', text: 'Make it calmer', at: 1 }, { author: 'agent', text: 'Softened the header', at: 2 }])
    render(
      <ThemeProvider>
        <CanvasThreadList
          manifest={{ title: 'Canvas', pages: [], sections: [], frames: [FRAME], annotations: [] }}
          onReply={onReply}
          onReveal={onReveal}
          onStatus={onStatus}
          threads={[open, thread('b', 'resolved', 1)]}
        />
      </ThemeProvider>,
    )
    expect(screen.getByText('Softened the header')).toBeTruthy()
    expect(screen.queryByText('Note b')).toBeNull()

    fireEvent.changeText(screen.getByLabelText('Reply to Home › Composer'), 'Thanks')
    await act(async () => { fireEvent.press(screen.getByText('Reply')) })
    expect(onReply).toHaveBeenCalledWith('a', 'Thanks')

    await act(async () => { fireEvent.press(screen.getByText('Resolve')) })
    expect(onStatus).toHaveBeenCalledWith('a', 'resolved')

    fireEvent.press(screen.getByLabelText('Show Home'))
    expect(onReveal).toHaveBeenCalledWith('home')

    fireEvent.press(screen.getByText('RESOLVED · 1'))
    expect(screen.getByText('Note b')).toBeTruthy()
    expect(screen.getByText('Reopen')).toBeTruthy()
  })
})

describe('frame comment context', () => {
  const target = { ok: true as const, selector: 'button', tag: 'button', rect: { x: 10, y: 20, width: 100, height: 40 } }

  it('anchors at the tap, clamped to the frame, with its label and section', () => {
    expect(frameCommentContext(FRAME, [{ id: 's', title: 'Onboarding', frames: ['home'], status: 'idea' }], { ...target, anchor: { point: { x: 500.4, y: 120.6 }, label: 'Composer', labelId: 'composer' } }))
      .toMatchObject({ frameId: 'home', frameTitle: 'Home', point: { x: 390, y: 121 }, label: 'Composer', labelId: 'composer', section: 'Onboarding', status: 'idea' })
  })

  it('falls back to the element centre without an anchor', () => {
    expect(frameCommentContext(FRAME, [], target).point).toEqual({ x: 60, y: 40 })
  })
})
