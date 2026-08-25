# Playbook: iteration

Use from the second round of feedback onward — the moment an artifact carries
both settled decisions and live questions. Read it together with the playbook
for what the artifact *is* (plan, comparison, mockup, input).

A review that accretes is a review the user has to re-read. Two failures cause
it, and they need different fixes:

- **Accretion** — settled sections keep the same weight, order and nav position
  as live ones, so nothing signals where the work is now.
- **Amnesia** — an answered control renders blank after you rewrite the body,
  because sending removes the answer from the daemon's pending store. The user
  cannot tell whether they already answered.

## One section per topic, forever

Structure the document by topic, not by round. A topic gets a stable `id` and
keeps its position for the life of the review, no matter how many rounds touch
it. Round-first grouping scatters a single subject across the document; a
reader asking "where did we land on placement?" should never have to look in
three places.

Inside a topic, newest state is on top:

```html
<section id="placement" data-redline-section data-redline-label="Placement"
         data-redline-status="decided" data-redline-round="2">
  <h2>Placement</h2>
  <redline-choice key="placement" prompt="Which placement?"
    options="HUD,Edge,Footer"
    resolved answer="Footer" answered-in="Round 2"></redline-choice>

  <details class="redline-thread">
    <summary>2 earlier exchanges in this topic</summary>
    <div class="redline-exchange">
      <p>R1 — HUD, edge, or footer?</p>
      <p class="redline-exchange-answer">→ Footer</p>
    </div>
  </details>
</section>
```

## Status, round, and what changed

Stamp every section:

- `data-redline-status="open"` — still needs the user.
- `data-redline-status="decided"` — settled; keep it in place, folded.
- `data-redline-round="<n>"` — the round that last touched it.
- `data-redline-changed="<n>"` — you changed it this round.

The default theme renders these as chips and a "new this round" badge, and
`<redline-nav>` mirrors them onto its links with an open/decided tally. Open
vs settled answers "what still needs me?"; changed vs unchanged answers "what
did you just do to the document?" — the second question is the one the user
asks right after a reload, so do not skip the changed stamp.

## Settled controls keep their answer

Never leave an answered control live and empty, and never silently delete it.
Rewrite it as resolved, carrying the answer you actually received:

```html
<redline-approve key="plan" prompt="Build this?"
  resolved answer="approve" answered-in="Round 2"
  note="Ship the playbook first."></redline-approve>
```

The SDK renders the recorded answer, the note, and a **Reopen** button that
restores the live control pre-filled — so the user can change their mind
without you having to re-ask. Add `locked` when a decision must not be
reopened. For a multi-select, pass the answer exactly as it was queued
(`answer="A, C"`); the SDK splits it back into one chip per value.

## Mirror every decision into a log

Keep a `<section class="redline-log">` at the end holding one row per
decision: round, topic, the answer, and the user's note. Mirror a decision
into it **as soon as it is made** — the log is a consolidated record, not a
place topics move to when they get old. Topics stay where they are; the log
is the thing the user can read top-to-bottom to see everything settled, and
paste into a plan note as a handoff.

Link both ways: the log's topic cell links to the section, the section's
thread references the round.

## Unanswered questions stay live

If the user answers three of four controls, the fourth is not settled. Leave
it open, and say so in the prompt ("Still open from round 1: …"). Quietly
dropping an unanswered question is how a review loses a requirement.

## Several discussions in one artifact

A review often grows past a single thread — an overall requirements
discussion plus deep dives such as backend architecture and UI. Keep one
artifact and give every topic a `data-redline-track`, then present the tracks
as a tab strip with per-track open counts. The decision log stays global
across every track, so there is still one place that answers "what have we
settled?".

```html
<section id="auth-shape" data-redline-section data-redline-track="backend"
         data-redline-status="open" data-redline-round="3">
```

Organise for the reader's cognitive load, not for tidiness. A hundred-screen
scroll is hard to reason about, and so is a strip of twenty tabs — judge from
the actual topics and the amount of detail each carries. Useful defaults:

- **One track** until the document genuinely holds separate conversations.
  Do not open tracks up front on the chance they fill up.
- **Split when a topic accumulates its own sub-topics** — the moment a subject
  has several open questions and its own history, it reads better as a track.
- **Distinct UI surfaces usually deserve their own track**, since their
  questions, screenshots and decisions rarely interleave usefully.
- **Merge back** if a track ends up holding one settled topic; a tab that
  never changes is noise.

Every section still needs a stable `id`: hidden tracks stay in the DOM, and a
review note's selector has to survive the user switching tabs between writing
the note and you applying it.

A deep dive that outgrows a tab can graduate to its own artifact under
`.redline/<topic>/` without changing the topic-thread model underneath — the
tracks, statuses and resolved controls all work the same there.
