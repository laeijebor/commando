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
  renders the returned queue. `src/pendingMirror.ts` keeps a localStorage
  mirror per pane as belt and braces: it is restored (re-POSTed) only when
  the daemon definitively reports an empty queue, and cleared whenever the
  queue empties legitimately (send, removals), so sent notes cannot
  resurrect.

## Failure-mode coverage

| Loss mode before | Now |
| --- | --- |
| Session switch / tile unmount | Pills are daemon state; rehydrated on remount |
| Page reload | Same — GET + `pending` push rehydrate |
| Answer queued with no viewer connected | Binding writes to the store; no viewer needed |
| Daemon restart | Pending journal replayed (panes persist restarts) |
| Daemon journal lost | localStorage mirror re-queues on next mount |
| Feedback queue full at Send | 429; notes stay pending for a retry |
