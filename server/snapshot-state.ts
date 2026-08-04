import { isDeepStrictEqual } from 'node:util'

import type { CommandoSnapshot } from '../shared/protocol.js'

const ANIMATED_BRAILLE_PREFIX = /^[\u2800-\u28ff](?=\s|$)/u

function panePublicationState(pane: CommandoSnapshot['panes'][number]) {
  const {
    alternateSavedX: _alternateSavedX,
    alternateSavedY: _alternateSavedY,
    cursorX: _cursorX,
    cursorY: _cursorY,
    title,
    ...state
  } = pane
  return {
    ...state,
    title: title.replace(ANIMATED_BRAILLE_PREFIX, '\u2800'),
  }
}

function snapshotPublicationState(snapshot: CommandoSnapshot) {
  return {
    sessions: snapshot.sessions,
    windows: snapshot.windows,
    panes: snapshot.panes.map(panePublicationState),
    ports: snapshot.ports,
  }
}

export function snapshotsHaveSameState(
  left: CommandoSnapshot,
  right: CommandoSnapshot,
): boolean {
  return isDeepStrictEqual(
    snapshotPublicationState(left),
    snapshotPublicationState(right),
  )
}
