import { FlatList } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { ThemeProvider } from '../theme'
import { ChatTimeline } from './ChatTimeline'
import { item } from './testing'
const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 1500 }, layoutMeasurement: { width: 390, height: 500 } } })
beforeEach(() => jest.useFakeTimers())
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers() })
it('follows open/send and pinned streaming, preserves a reader above the end, and handles keyboard resize', async () => {
  const scroll = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => undefined)
  const items = [item('user_message', { text: 'Latest question' })]
  const timeline = (sendVersion = 0) => <ThemeProvider><ChatTimeline baseUrl="http://studio" cwd="/tmp" items={items} working={false} sendVersion={sendVersion} /></ThemeProvider>
  const view = render(timeline())
  await act(async () => undefined)
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).toHaveBeenCalled()
  scroll.mockClear()
  fireEvent(screen.getByTestId('chat-timeline'), 'contentSizeChange', 390, 1500)
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).toHaveBeenCalled()
  fireEvent(screen.getByTestId('chat-timeline'), 'scrollBeginDrag')
  fireEvent.scroll(screen.getByTestId('chat-timeline'), scrollEvent(300))
  fireEvent(screen.getByTestId('chat-timeline'), 'scrollEndDrag', scrollEvent(300))
  scroll.mockClear()
  fireEvent(screen.getByTestId('chat-timeline'), 'contentSizeChange', 390, 1600)
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Jump to the newest turn')).toBeTruthy()
  view.rerender(timeline(1))
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).toHaveBeenCalled()
  expect(screen.queryByLabelText('Jump to the newest turn')).toBeNull()
  scroll.mockClear()
  fireEvent(screen.getByTestId('chat-timeline'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 300 } } })
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).toHaveBeenCalled()
})
it('ignores the momentum end of its own scrollToEnd, so following never loops', async () => {
  const scroll = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => undefined)
  render(<ThemeProvider><ChatTimeline baseUrl="http://studio" cwd="/tmp" items={[item('user_message', { text: 'Hi' })]} working={false} /></ThemeProvider>)
  await act(async () => undefined)
  act(() => jest.advanceTimersByTime(30))
  scroll.mockClear()
  // iOS reports a momentum end for the programmatic scroll, with no begin.
  fireEvent(screen.getByTestId('chat-timeline'), 'momentumScrollEnd', scrollEvent(1000))
  act(() => jest.advanceTimersByTime(30))
  expect(scroll).not.toHaveBeenCalled()
})
it('marks an attached video with a film tile instead of loading it as an image', async () => {
  const video = `${'e'.repeat(64)}.mov`
  const image = `${'a'.repeat(64)}.png`
  render(<ThemeProvider><ChatTimeline baseUrl="http://studio" cwd="/tmp" items={[item('user_message', { text: 'Watch', images: [{ id: video, name: 'clip.mov' }, { id: image, name: 'pane.png' }] })]} working={false} /></ThemeProvider>)
  await act(async () => undefined)
  expect(screen.getByLabelText('Video: clip.mov')).toBeTruthy()
  expect(screen.queryByLabelText('Open clip.mov')).toBeNull()
  expect(screen.getByLabelText('Open pane.png')).toBeTruthy()
})
