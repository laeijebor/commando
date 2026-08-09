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
