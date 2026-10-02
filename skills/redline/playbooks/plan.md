# Playbook: plan

Use for a product or technical plan going up for review before work starts.

## Structure

1. **Decision summary box** at the top — what's being proposed, and what
   approving it commits the user to. One or two sentences, visually set off
   (bordered box, tinted background) so it reads before anything else does.
   With the default theme, use
   `<section class="redline-callout" id="decision-summary">...</section>`.
2. **Scope** — what's in.
3. **Approach** — how, at the level a reviewer needs to sanity-check it, not
   full implementation detail.
4. **Risks** — what could go wrong, and how likely/costly each is.
5. **Out of scope** — explicitly what this plan does *not* cover, so the
   reviewer isn't left guessing whether an omission was deliberate.

## Author the reasoning with plan components

Load `/redline/sdk.js` once as described in the skill. These elements enhance
their authored children in place; keep meaningful text, links, and stable IDs
on sections and reviewable items. `heading` adds an optional heading; it does
not supply the underlying reasoning. Side-by-side pairs stack in narrow tiles;
the file tree wraps paths and the diff scrolls within itself. Inspect the
actual tile at its narrow width.

Show **observed actual state** and **proposed future state** explicitly. A
proposal must not look like a verified implementation. For a comparison, use
direct `data-before` and `data-after` children; `data-label` changes their
badges:

```html
<redline-before-after id="session-state" heading="Session storage">
  <div id="session-before" data-before data-label="Actual"><p>Sessions currently live in process memory; restart loses them.</p></div>
  <div id="session-after" data-after data-label="Proposed"><p>Persist sessions in Postgres so restarts preserve them.</p></div>
</redline-before-after>
```

An implementation map is a nested list of directories (`li[data-dir]`) and
files (`li[data-path]`). The SDK folds directories into disclosures, adds a
status/provenance badge per file and a summary count. `data-status` may be
`add`, `modify`, `move`, `delete`, `existing`, or `proposed`; omitted means
`existing`. `existing` defaults to actual unless `data-proposed` is present;
all other statuses default to proposed unless `data-actual` is present.
Explicitly label verified changed files with `data-actual` and planned
existing files with `data-proposed` when appropriate. Keep the file's purpose
in authored content, not only in its badge. `data-diff="#id"` adds a View diff
link only for a fragment target; the target must exist as an ID on the
corresponding `<redline-code-diff>` (see `playbooks/code.md`). Use
`data-collapsed` on a directory to start it closed.

```html
<redline-file-tree id="implementation" heading="Implementation map">
  <ul><li data-dir="server" data-collapsed>server
    <ul>
      <li id="session-file" data-path="server/session.ts" data-status="modify" data-diff="#session-diff">server/session.ts — persist sessions (proposed)</li>
      <li id="store-file" data-path="server/store.ts" data-status="existing" data-actual>server/store.ts — current database wrapper (verified)</li>
    </ul>
  </li></ul>
</redline-file-tree>
```

For milestones, evidence, scenarios, and risks, the SDK badges items marked
`data-milestone`, `data-evidence`, `data-step`, or `data-risk`; optional
`data-status` adds a status badge. Write the acceptance criteria, source,
given/when/then conditions, and mitigation in the item's own text. A label
or status alone cannot establish any of these. Evidence should identify a
real observation/source or state that a check is still proposed. The example
is illustrative: replace the observed claim with your own verified source
before publishing it as actual evidence.

```html
<redline-milestones id="delivery" heading="Milestones">
  <div id="persist" data-milestone="Persist" data-status="proposed">Add storage and migration; done when a session survives restart.</div>
  <div id="rollback" data-milestone="Rollback" data-depends-on="Persist" data-status="proposed">Rehearse rollback by restoring the old read path without deleting session rows.</div>
</redline-milestones>
<redline-evidence id="proof" heading="Evidence">
  <div id="current-proof" data-evidence="Actual" data-status="observed">Observed: session disappears after restart (source: local restart test, run 2026-09-24).</div>
  <div id="future-proof" data-evidence="Proposed" data-status="pending">After implementation, rerun restart test and record its result.</div>
</redline-evidence>
<redline-scenario id="restart-scenario" heading="Restart scenario">
  <div id="given-session" data-step="Given">A user has a valid session stored before restart.</div>
  <div id="when-restarted" data-step="When">The service restarts and the user requests a page.</div>
  <div id="then-restored" data-step="Then">The same session resolves without signing in again.</div>
</redline-scenario>
<redline-risk id="migration-risk" heading="Risks">
  <div id="schema-rollback" data-risk="Migration rollback" data-likelihood="low" data-impact="high" data-status="open">Old readers may fail on new rows; keep a backward-compatible read path and rehearse rollback before rollout.</div>
</redline-risk>
```

Tradeoffs use direct `data-option` children; `data-label` overrides the option
badge and `data-recommended` adds a Recommended badge. Put the actual costs
and assumptions inside each option, not just in its name:

```html
<redline-tradeoffs id="storage-options" heading="Storage choice">
  <div id="postgres-option" data-option="postgres" data-label="Postgres" data-recommended><p>Assumes the existing database can handle session writes; adds a migration and query load.</p></div>
  <div id="redis-option" data-option="redis" data-label="Redis"><p>Fast TTLs; adds an operational dependency and persistence policy.</p></div>
</redline-tradeoffs>
```

`<redline-decision>` is a focused checkpoint, not the overall approval gate.
Its `recommended` and `alternative` attributes identify the options in the
queued structured response; the UI offers **Accept recommended**, **Accept
alternative**, and **Needs investigation**. Author the rationale alongside
it. Selecting a radio or typing a note stays local; **Queue decision** queues
the selection (or a note alone), and the user must still send the queue.
Give it a stable `key` so re-queueing replaces the unsent answer.

```html
<redline-decision id="storage-decision" key="session-storage" prompt="Which storage path?"
  recommended="postgres" alternative="redis">
  <p>Postgres avoids another service; investigate peak write load if needed.</p>
</redline-decision>
```

`<redline-scope>` creates checkboxes for authored
`[data-scope-id][data-optional]` descendants. `data-label` names a checkbox;
`data-default="off"` starts excluded, otherwise included. Give each item a
stable `id` so its checkbox can point to it. Toggling only shows/hides that
item locally; it does **not** queue, change implementation, or remove it from
the DOM. **Queue scope answer** records included/excluded scope IDs and the
optional rationale; the user still sends the queue. Use a stable `key`.

```html
<redline-scope id="scope-review" key="session-scope" prompt="Include optional scope?">
  <div id="audit-logs" data-scope-id="audit-logs" data-optional data-label="Audit logs" data-default="off">Proposed: add an audit trail after session persistence is verified.</div>
  <div id="backfill" data-scope-id="backfill" data-optional data-label="Backfill">Proposed: migrate existing sessions; depends on a legacy export.</div>
</redline-scope>
```

## Open questions live inline, not at the bottom

Every open question gets its own review control placed directly at the point
in the text where the question arises — not collected in an appendix the
reader has to scroll back to cross-reference against context they've since
forgotten:

```html
<p>We could store sessions in Redis or in Postgres...</p>
<redline-choice key="session-store" prompt="Session storage?"
  options="Redis,Postgres"></redline-choice>
```

Use `<redline-ask>` instead when the question doesn't reduce to a closed set
of options.

## Close with one approval gate

End the plan with a single overall approval control:

```html
<redline-approve key="plan" prompt="Approve this plan as written?"></redline-approve>
```

Section-level choices feed the plan's specifics; this final control is the
one signal that means "start building." Don't skip it even if every inline
question already got answered — it's the explicit go-ahead.
