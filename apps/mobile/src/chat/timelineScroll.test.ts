import { isNearTimelineEnd, shouldFollowTimeline } from './timelineScroll'
it('always follows on open, send or an explicit jump, even while reading older turns', () => {
  for (const reason of ['open', 'send', 'jump'] as const) expect(shouldFollowTimeline(reason, false, true)).toBe(true)
})
it('pins content growth and keyboard/layout resize only when already near the end and not dragging', () => {
  for (const reason of ['content', 'resize'] as const) {
    expect(shouldFollowTimeline(reason, true)).toBe(true)
    expect(shouldFollowTimeline(reason, false)).toBe(false)
    expect(shouldFollowTimeline(reason, true, true)).toBe(false)
  }
})
it('measures distance to the newest turn for chronological lists, including short histories', () => {
  const event = (y: number, height = 1500, viewport = 500) => ({ contentOffset: { x: 0, y }, contentSize: { width: 390, height }, layoutMeasurement: { width: 390, height: viewport } })
  expect(isNearTimelineEnd(event(0))).toBe(false)
  expect(isNearTimelineEnd(event(500))).toBe(false)
  expect(isNearTimelineEnd(event(930))).toBe(true)
  expect(isNearTimelineEnd(event(1000))).toBe(true)
  expect(isNearTimelineEnd(event(0, 200))).toBe(true)
})
