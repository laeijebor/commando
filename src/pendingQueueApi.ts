import type { WebPanePendingSnapshot } from '../shared/protocol'
import type { RedlinePageResponse } from '../shared/redline-response'
import type { PendingNoteDraft, PendingSendTarget } from './webPanesApi'

/** Daemon-side pending review queue for one tile. */
export type PendingQueueApi = {
  list: () => Promise<WebPanePendingSnapshot>
  add: (note: PendingNoteDraft) => Promise<WebPanePendingSnapshot>
  addResponse?: (pageUrl: string, response: RedlinePageResponse) => Promise<WebPanePendingSnapshot>
  update: (
    noteId: number,
    expectedRevision: number,
    change: { answer?: string; note?: string },
  ) => Promise<WebPanePendingSnapshot>
  upload: (noteId: number, expectedRevision: number, file: File) => Promise<WebPanePendingSnapshot>
  removeAttachment: (
    noteId: number,
    expectedRevision: number,
    attachmentId: string,
  ) => Promise<WebPanePendingSnapshot>
  attachmentUrl: (attachmentId: string) => string
  remove: (noteId: number) => Promise<WebPanePendingSnapshot>
  send: (targets?: readonly number[] | readonly PendingSendTarget[]) => Promise<WebPanePendingSnapshot>
  dismissDropped: () => Promise<WebPanePendingSnapshot>
}
