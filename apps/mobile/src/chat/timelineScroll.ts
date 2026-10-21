import type { NativeScrollEvent } from 'react-native'

export type TimelineScrollReason = 'open' | 'send' | 'jump' | 'content' | 'resize'
export function shouldFollowTimeline(reason: TimelineScrollReason, nearBottom: boolean, userScrolling = false): boolean {
  return reason === 'open' || reason === 'send' || reason === 'jump' || (nearBottom && !userScrolling)
}
export function isNearTimelineEnd(event: Pick<NativeScrollEvent, 'contentOffset' | 'contentSize' | 'layoutMeasurement'>): boolean {
  return event.contentSize.height - event.layoutMeasurement.height - event.contentOffset.y <= 80
}
