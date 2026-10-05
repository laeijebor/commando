# Playbook: input

Use whenever the artifact's job is to collect decisions, choices, or triage
from the user rather than just to display something.

## Queue discipline

Redline separates editing, queuing, and sending:

1. Built-in choice, approve, and rating selections queue immediately. Free
   text, note-only answers, decision, and scope controls use the explicit
   **Queue answer** / **Queue decision** / **Queue scope answer** button.
2. The queue snapshot is authoritative. Selecting or pressing a queue button
   never sends to the agent. Re-answering with the same stable `key` replaces
   the unsent entry. Section/track switches and hashes preserve that identity.
3. Only **Send all** or **Send this** delivers feedback. **Send all + Build**
   explicitly adds build intent; don't treat it as interchangeable with send.

For custom controls, choose and explain auto-queue versus manual queue; don't
change the SDK's existing queue behavior for a visual redesign. Put questions
beside their evidence in `<redline-nav mode="sections">` documents, with stable
section ids, short labels, and optional `data-redline-group` metadata. Hidden
questions remain in inventory, and the feedback tray's **Show in page** opens
the correct section/track before scrolling.

## Which element for which question

| element | use when |
|---|---|
| `<redline-choice>` | closed set of options (add `multiple` for more than one) |
| `<redline-approve>` | verdict on something already shown (approve/reject/needs-changes) |
| `<redline-rating>` | calibration on a scale (`max` attribute, default 5) |
| `<redline-ask>` | open-ended text the options list can't capture |
| `<redline-question>` | a composite form — wrap your own `<input>`/`<select>`/`<textarea>` fields inside it |

Prefer `<redline-option>` children for prose labels. Commas, apostrophes, and
quotation marks remain ordinary HTML text (escape `&` and `<` as usual):

```html
<redline-choice key="attachments" prompt="Forward attachments?">
  <redline-option>Yes, carry the attachments</redline-option>
  <redline-option>No — say attachments aren't supported</redline-option>
</redline-choice>
```

`<redline-choice>` also accepts the compact comma-separated form for simple
labels, for example `options="Starter,Pro"`. JSON arrays remain supported:
`options='["Ten — Pulse, Crest, Kiln, Ridge","Twelve — all six"]'`. Escape every
apostrophe inside a single-quoted attribute as `&#39;`; backslashes do not
escape HTML quotes. Invalid JSON shows an error instead of splitting into
misleading options. Child options take precedence when both forms are present.

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
Components arrive self-styled (flat surfaces, dark/light-aware) —
override accents via `--redline-accent`/`--redline-accent2`; the injected
rules are zero-specificity, so artifact CSS can still restyle them if needed.
The Commando default artifact theme supplies matching slate/lavender accent
variables automatically.

Every built-in control has one optional note field. The note is delivered as
`response.note`, not folded into `response.answer`. The queue drawer also
supports per-answer image attachments and `Send this` for selective delivery.

## Prompt quality

Write prompts specific enough that the drained note is actionable on its
own, without a follow-up round-trip: "Should the timeout be 30s or 60s?" not
"Thoughts on timeout?".
