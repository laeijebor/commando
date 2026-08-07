# Durable review-feedback delivery (journal + cursor acks)

**Problem.** Review feedback (annotations and redline component answers) was
delivered with drain-is-the-ack semantics: the daemon deleted notes the moment
it wrote the long-poll response. A poll whose response never reached the agent
(killed background task, curl timeout, compaction mid-poll), a daemon restart,
or a tile closed before draining lost the user's answers permanently.

**Goal.** At-least-once delivery: once the user presses Send, answers survive
missed polls, daemon restarts, and closed tiles, and remain fetchable until an
agent acknowledges them.

## Design

- **Journal** (`server/web-pane-feedback-journal.ts`): append-only JSONL per
  web pane under `~/.commando/feedback/<webPaneId>.jsonl` — note entries
  `{k:'n',id,at,note}` and ack markers `{k:'a',upTo,at}`. Replayed on load;
  compacted past 200 lines; journals expire after 7 days (sweep at daemon
  startup). Pane ids are validated (`[A-Za-z0-9_-]{1,64}`) before touching
  paths.
- **Store** (`server/web-pane-feedback.ts`): notes get per-pane monotonic ids.
  Draining delivers the full unacked backlog but deletes nothing. Acking
  happens when a later drain passes the previous response's `cursor` back;
  acks are clamped to the highest delivered id so a wild cursor cannot discard
  unseen answers. The 50-note cap counts only undelivered notes. `retain()`
  drops in-memory state for dead panes but leaves journals on disk.
- **API** (`server/web-panes-api.ts`): `GET …/feedback?wait=&cursor=N`
  responds `{ok, webPaneId, cursor, notes}` with `cursor` serialized before
  `notes` (consumers may extract it textually). Notes carry `id`. For a
  closed pane the drain applies the cursor first and serves any remaining
  backlog with `wait=0`; an empty result is the review-over `404` — so 404 now
  means "review ended AND nothing unread".
- **Script** (`scripts/commando-feedback`): threads the cursor automatically
  via `~/.commando/feedback-cursors/<paneId>` (override:
  `COMMANDO_FEEDBACK_CURSOR_DIR`), writing it only after the response was
  printed and removing it on 404.
- **Consumers without cursors** (raw curl, old scripts) never ack: they
  safely re-receive the backlog each poll and dedupe by note `id`.
- **Unchanged**: the client Send path, pill queue, redline components, and
  the `page_response` relay. (Superseded for the pre-Send pill queue by
  `2026-08-07-pending-notes-design.md` — pills are now daemon state too.)

## Failure-mode coverage

| Loss mode before | Now |
| --- | --- |
| Poll response lost mid-flight | Retry (old/no cursor) redelivers the same notes |
| Daemon restart | Journal replayed; backlog re-offered as undelivered |
| Tile closed before drain | Backlog served until acked, then 404 |
| Buggy consumer acks too far | Ack clamped to delivered ids |
