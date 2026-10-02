# Sent redline answers stay answered

**Problem.** A redline page question is only "answered" while its response sits
in the pending queue. Send removes the note from the queue
(`server/web-pane-pending.ts` `send`), so the in-page control reverts to a live
question and the review drawer lists it as unanswered again. It only looks
settled once the agent rewrites the control with `resolved answer="…"` and
reloads. Between send and that rewrite — or forever, if the agent never
rewrites — a reload shows the question as open and invites a second answer.

**Goal.** A sent answer keeps showing as answered in the page and in the review
drawer, across reloads, daemon restarts, and closing/reopening a tile on the
same page, until the agent changes the question or settles it itself.

**Scope.** Redline page questions (`<redline-choice>`, `<redline-approve>`,
`<redline-rating>`, `<redline-ask>`, `<redline-question>`) and the review
drawer in `src/TileReviewLayer.tsx`, for both Chromium and native WebView
tiles. Out of scope: agent permission / AskUserQuestion answers
(`server/agent-request-answers.ts`), and showing attachments on sent answers.

## Behaviour

- **Page.** A control with a matching sent record renders with the existing
  resolved treatment (`renderResolved` in `server/static/redline-sdk.js`):
  answer chips, the note, and meta text **"Sent · <relative time>"** plus
  **Reopen**. A sent skip renders "Skipped" instead of chips.
- **Precedence**, highest first, identical in the SDK and the drawer:
  1. Agent-authored `resolved` attribute (its `answer`, `note`,
     `answered-in`, `locked` win).
  2. A queued (pending) answer.
  3. A sent record whose question shape matches the live question.
  4. Live, unanswered.
- **Question match.** A sent record applies only while the live question has
  the same identity (`queueKey`, else selector) **and** the same shape: prompt
  text, kind, options, `multiple`, `max`. Rewording or changing options makes
  it live again — that is how an agent re-asks in place.
- **Page match.** Pages are compared by origin + path; query string and hash
  are ignored, so a `?v=<n>` cache-bust reload keeps sent state.
- **Reopen** is view-local: it restores the live control pre-filled with the
  sent answer and does not delete the record, so a reload without re-answering
  shows it as sent again. Queueing a new answer behaves as today; sending it
  replaces the record.
- **Drawer.** Questions have three states — unanswered, queued, sent. The
  Unanswered filter excludes queued and sent. A sent question shows its answer
  read-only with a **Change answer** action that behaves like Reopen. A queued
  answer shadows a sent one.

## Design

### 1. Sent-answer store — `server/web-pane-sent-answers.ts` (new)

- `redlinePageKey(url)` (shared): `origin + pathname`; non-http(s)/unparseable URLs fall back
  to the URL with query and hash stripped.
- Record per question identity within a page (`key:<queueKey>` or
  `selector:<selector>`), latest only:

  ```ts
  type WebPaneSentAnswer = {
    queueKey?: string
    selector?: string
    shape: RedlineQuestionShape // question, kind, options?, multiple?, max?
    response: { question: string; answer: string; note?: string; data?: unknown }
    sentAt: number
  }
  ```

  A skip is recorded as the SDK's `(skipped)` stand-in answer, so it needs no
  separate flag.

- One JSON file per page under `~/.commando/sent-answers/`, named by a hash of
  the page key, written atomically (temp file + rename). No expiry — growth is
  bounded by distinct questions because records are replaced, not appended,
  with a safety cap of 1,000 records per page (oldest dropped). Pages receive
  at most the 200 newest within the page snapshot byte budget.
- API: `record(pageUrl, records)`, `forPage(pageUrl)`. Directory injectable for
  tests, mirroring `FeedbackJournal`.

### 2. Recording on send

- Queued page responses gain an optional `shape` (`RedlineQuestionShape`),
  supplied where the question is known: the SDK's queue payload (from
  `questionDescriptor()`) and the drawer's `responseForQuestion`.
  `parseRedlinePageResponse` validates it with the existing inventory limits.
  The pending note stores it alongside `response`.
- In `WebPanePendingStore.send`, after `enqueue` returns (the feedback journal
  accepted the notes), notes that carry a `response` and `shape` are written to
  the sent store under their note's `pageUrl`. A throwing enqueue records
  nothing. A store write failure is logged and does not fail the send (the
  feedback was delivered; only the UI hint is lost).
- Responses without a shape (older SDKs) are delivered as today and not
  recorded.

### 3. Delivering records to viewers

The daemon tracks each tile's **current page** and adds that page's records to
the tile's pending snapshot as `sent: SentAnswerRecord[]`.

- **Chromium tiles.** The engine already updates `mainFrameUrl` on navigation;
  a new `onPageNavigated(webPaneId, url)` option sets the current page and
  rebroadcasts the pending snapshot. The engine builds the page-facing snapshot
  in-process, so the page is hydrated at navigation start.
- **Native WebView tiles.** Questions never reach the daemon on this path, so
  `NativeWebViewTile` calls a new owner-only
  `POST /api/web-panes/:id/pending/page {url}` when the bridge reports a
  navigation (it sits with the other pending routes rather than at `/page`). The response (and the broadcast) is the updated
  pending snapshot. A sent question may briefly render live on reload until
  this round trip completes.
- **Fallback.** Until a tile reports, its current page is `pane.url`.
- Every snapshot producer (`WebPanePendingStore.snapshot` callers in
  `server/index.ts`, `server/web-panes-api.ts`, `server/web-tile-relay.ts`)
  includes `sent`. Page-facing snapshots (`pagePendingSnapshot` in
  `server/chromium-engine.ts`, `redlinePendingSnapshotForPage` in
  `shared/redline-response.ts`) forward `sent` with the same size limits as
  `controls` and match pages by page key. The SDK's `validPendingSnapshot`
  only checks `version` and `controls`, so older pages ignore the field.

### 4. Rendering

- `shared/redline-response.ts` gains `RedlineQuestionShape`,
  `questionShapeOf(question)`, and `sameQuestionShape(a, b)`. The SDK carries a
  mirrored copy (it already mirrors inventory limits) guarded by a parity test.
- **SDK.** `applyPendingSnapshot` looks up a sent record after the pending
  control lookup. With a matching record and no `resolved` attribute, the
  control renders resolved from the record (a view-local state, not written to
  attributes) with the "Sent · …" meta. Reopen clears the view-local state.
- **Drawer.** `pendingForQuestion` is joined by `sentForQuestion`; the item
  state becomes `unanswered | queued | sent`, driving the counts, the
  Unanswered filter, and the detail panel.

## Testing

- `server/web-pane-sent-answers.test.ts`: page-key normalisation, latest record
  wins per identity, persistence across instances, corrupt-file tolerance.
- `server/web-pane-pending.test.ts`: send records shaped responses only after
  enqueue succeeds; throwing enqueue records nothing; shapeless responses are
  not recorded.
- `server/web-panes-api.test.ts`: `POST …/pending/page` updates the current page and
  returns a snapshot with that page's `sent`.
- `server/chromium-engine.test.ts`: navigation reports the page; page snapshot
  carries `sent` matched by page key across `?v=` changes.
- `server/static/redline-sdk.test.ts`: sent record renders resolved; changed
  prompt/options renders live; agent `resolved` wins; Reopen is view-local;
  shape helper parity with `shared/redline-response.ts`.
- `src/TileReviewLayer.test.tsx`: three states, Unanswered filter, Change
  answer, queued shadows sent.
- `src/NativeWebViewTile.test.tsx`: navigation posts the page and applies the
  returned snapshot.
- End to end: answer → send → reload the tile (and a `?v=` reload) → still
  shown as sent in the page and the drawer.
