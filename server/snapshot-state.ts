import { isDeepStrictEqual } from 'node:util'

import type { CommandoSnapshot } from '../shared/protocol.js'

type CommandoSnapshotState = Omit<CommandoSnapshot, 'capturedAt' | 'revision'>

function snapshotState(snapshot: CommandoSnapshot): CommandoSnapshotState {
  const { capturedAt: _capturedAt, revision: _revision, ...state } = snapshot
  return state
}

export function snapshotsHaveSameState(
  left: CommandoSnapshot,
  right: CommandoSnapshot,
): boolean {
  return isDeepStrictEqual(snapshotState(left), snapshotState(right))
}
