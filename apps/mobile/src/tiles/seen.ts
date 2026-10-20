import type { WebPane } from '@commando/protocol'
import { canStream } from './list'

/** A browser preview card is not the streamed page; wait until its first frame. */
export function tileWasViewed(tile: WebPane | undefined, foreground: boolean, hasFrame = false): boolean {
  return Boolean(tile?.unseen && foreground && (!canStream(tile) || hasFrame))
}
