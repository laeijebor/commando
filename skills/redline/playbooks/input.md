# Playbook: input

Use whenever the artifact's job is to collect decisions, choices, or triage
from the user rather than just to display something.

## Queue discipline

Every redline component follows the same three-stage flow — know it before
building a form with them:

1. Interacting with a control (checking a box, typing text) only updates
   **local state** in the browser. Nothing is sent yet.
2. Pressing the control's own **queue button** ("Queue answer") sends that
   one answer to the tile's pending list, exactly once per press.
3. The answer only reaches the agent when the user presses **Send** in the
   tile footer — queuing is not sending. Re-answering a queued question (same
   `key`) replaces the unsent entry rather than adding a duplicate.

Never wire a control to auto-queue on `change`/`input` — that breaks the "I
can still change my mind before I commit" contract the queue button exists
for.

## Which element for which question

| element | use when |
|---|---|
| `<redline-choice>` | closed set of options (add `multiple` for more than one) |
| `<redline-approve>` | verdict on something already shown (approve/reject/needs-changes) |
| `<redline-rating>` | calibration on a scale (`max` attribute, default 5) |
| `<redline-ask>` | open-ended text the options list can't capture |
| `<redline-question>` | a composite form — wrap your own `<input>`/`<select>`/`<textarea>` fields inside it |

## Keys

Give every question a unique `key` — it's how a re-answer replaces the
previous unsent one instead of piling up duplicates. The `key` itself never
reaches the drained note (it's stripped before the tile sends). To match an
answer back to its question programmatically, use `response.question` — the
`prompt` text, or the `key` itself when no `prompt` attribute was given,
since the SDK falls back to `key` as the question.

## Make queued state visible

The SDK renders `Queued ✓` only after the daemon's authoritative snapshot
confirms the answer. Reloads rehydrate the queued values. If the local answer
or optional note changes, the control turns amber and says `Changed since
queued`; don't suppress or restyle these states away. The user can update the
queued answer from the control or edit it in the tile's queue drawer.
Components arrive self-styled (glass "Aura" look, dark/light-aware) —
override accents via `--redline-accent`/`--redline-accent2`; the injected
rules are zero-specificity, so artifact CSS can still restyle them if needed.
The Commando default artifact theme supplies matching violet/cyan accent
variables automatically.

Every built-in control has one optional note field. The note is delivered as
`response.note`, not folded into `response.answer`. The queue drawer also
supports per-answer image attachments and `Send this` for selective delivery.

## Prompt quality

Write prompts specific enough that the drained note is actionable on its
own, without a follow-up round-trip: "Should the timeout be 30s or 60s?" not
"Thoughts on timeout?".
