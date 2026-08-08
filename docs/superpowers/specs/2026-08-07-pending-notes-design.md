# Durable pending review notes (pre-Send pills)

**Problem.** The feedback journal made answers durable *from Send onward*, but
the queued-but-unsent pills lived in `ChromiumTileCard` React state: focusing a
different session (or reloading) unmounted the tile and dropped them. Worse,
`page_response` was fan-out only — an answer queued while no tile viewer was
connected (hidden tab, other session focused) was dropped entirely, while the
in-page component still showed "Queued ✓".

**Goal.** Queued answers and annotations survive session switches, reloads,
disconnected viewers, and daemon restarts — while preserving the invariant
that nothing reaches the agent without the owner's explicit Send.

## Design

- **Store** (`server/web-pane-pending.ts`): daemon-owned per-pane queue of
  `WebPanePendingNote`s with server-assigned monotonic ids. Page-component
  answers enter via the CDP binding (`onPageResponse → addResponse`) with the
  lavish replace-not-stack rule per `queueKey` and a 50-note drop-oldest cap;
  manual annotations enter via `addNote` (429 past the cap). `send()` hands
  notes to the feedback store's `enqueue` and removes them only after it
  returns, so a full feedback queue leaves pending intact.
- **Journal**: `~/.commando/feedback/<paneId>.pending.jsonl` — note entries
  `{k:'n',id,at,note}`, removals `{k:'r',id,at}`, and a compaction id-pin
  `{k:'c',nextId,at}`. Same dir as the feedback journal so the 7-day TTL sweep
  covers both. Deleted when the pane closes (pending pills are dead then —
  unlike sent feedback, nobody can deliver them).
- **Relay** (`server/web-tile-relay.ts`): `page_response` fan-out is replaced
  by `{type:'pending', notes}` — the full authoritative queue, pushed on every
  mutation and on viewer connect. Viewers replace, never merge.
- **API** (`server/web-panes-api.ts`, owner-only): `GET/POST …/pending`
  (list / queue a note), `DELETE …/pending/:noteId`, `POST …/pending/send`
  (`{ids?}`; stamps the pane URL + send-time `capturedAt`, returns the
  remaining queue and the feedback `queued` count).
- **Client** (`src/ChromiumTileCard.tsx`): pills render daemon state —
  hydrated by GET on mount, refreshed by `pending` pushes; every mutation
  renders the returned queue. A push always wins over an in-flight hydrate
  response, which is strictly staler.

## Review revisions (2026-08-08)

Three changes from the redline review of this spec:

- **Mirror restore is watermark-guarded, not empty-queue-guarded.** The
  original rule (restore only when the daemon reports an empty queue) both
  under-restored and still allowed a stale second client to resurrect sent
  notes. Snapshots now carry `knownUpTo` — the highest id the pane has ever
  issued, which never decreases as notes are sent or removed. A mirrored
  note at or below it has been accounted for; only ids *above* it are
  genuinely unknown to the daemon, which happens exactly when the journal
  was lost. That is a server-side fact, so it holds across clients where a
  client-local tombstone would not.
- **Closing a tile no longer discards unsent pills.** Journals record their
  page URL (`{k:'u',url,at}`) and survive the close; opening a chromium tile
  adopts the leftovers of closed panes on the same URL, re-issuing ids in the
  new pane's sequence and deleting the absorbed journals so nothing is
  adopted twice. A pane still open on that URL is never robbed. Journals
  whose notes were all sent are empty and get swept rather than adopted, so
  sent notes still cannot come back. The 7-day TTL applies as before.
- **Capped page answers are dropped loudly.** Both cap paths are now equally
  visible: manual notes still fail with a 429, and page answers still
  drop-oldest (a runaway page must not be able to wedge the queue by
  refusing new answers) but the count rides along in the snapshot as
  `dropped`, rendering a warning in the tile's pill strip that the owner
  dismisses via `POST …/pending/dropped`. Sending clears it.

## Failure-mode coverage

| Loss mode before | Now |
| --- | --- |
| Session switch / tile unmount | Pills are daemon state; rehydrated on remount |
| Page reload | Same — GET + `pending` push rehydrate |
| Answer queued with no viewer connected | Binding writes to the store; no viewer needed |
| Daemon restart | Pending journal replayed (panes persist restarts) |
| Daemon journal lost | localStorage mirror re-queues ids above the watermark |
| Feedback queue full at Send | 429; notes stay pending for a retry |
| Tile closed mid-review | Journal survives; reopening the same URL adopts it |
| Stale second client with a sent-notes mirror | Watermark marks them accounted for; no resurrection |
| Runaway page floods the queue | Oldest dropped, but counted and shown in the tile |
