# Redline Aura Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five redline components look excellent (approved "Aura" treatment) in any artifact with zero artifact cooperation — no DaisyUI dependency, automatic dark/light adaptation, overridable accent.

**Architecture:** Presentation-only change confined to `server/static/redline-sdk.js` (+ its jsdom test + two one-line doc touches). The SDK injects one guarded `<style>` block; markup drops DaisyUI utility classes; all rules are `:where()`-scoped zero-specificity; neutrals derive from `currentColor` via `color-mix`, accent from `--redline-accent`/`--redline-accent2`. Spec: `docs/superpowers/specs/2026-08-07-redline-aura-styling-design.md`.

**Tech Stack:** Plain browser JS/CSS (no build step), vitest + jsdom.

## Global Constraints

- Behavior is untouched: queue discipline, binding contract, payload shapes, re-arm poller, caps, DOM hooks (`redline-queue`, `redline-options`, `redline-prompt`, `redline-comment`, `redline-queued-badge`), button/badge text ("Queue answer", "Queued ✓", "queued — see tile footer"), and the binding-absent disabled+hint path all stay byte-identical in behavior.
- Every injected CSS rule is wrapped in `:where()` rooted at a redline element name — zero specificity.
- Style block injected exactly once even if the SDK is evaluated twice (guard like `defineOnce`).
- Accent custom properties: `--redline-accent` default `#7c6cf6`, `--redline-accent2` default `#5aa9f7`, read with inheritance (`var(--redline-accent, #7c6cf6)` at use sites).
- No DaisyUI class names remain anywhere in the SDK (`btn`, `radio`, `checkbox`, `textarea` as class, `badge`, `rating`, `mask`, `mask-star-2`, size/color suffixes).
- The SDK stays a single plain `.js` file served verbatim; `npm run typecheck` and the full suite stay green.

---

### Task 1: Aura restyle of the SDK

**Files:**
- Modify: `server/static/redline-sdk.js`
- Modify: `server/static/redline-sdk.test.ts`

**Interfaces:**
- Consumes: existing SDK structure (queueButton, markQueued, promptHeading, RedlineElement subclasses, defineOnce, binding poller).
- Produces: same public surface; new internal `injectStyles()`; class attribute changes only.

- [ ] **Step 1: Write the failing tests**

In `server/static/redline-sdk.test.ts` add (and adjust existing assertions in the same pass — they currently reference DaisyUI classes only implicitly via structure, so check each selector still matches; the rating test's `input` query is structural and stays valid):

```ts
describe('injected styles', () => {
  it('injects the aura stylesheet exactly once across double evaluation', () => {
    loadSdk()
    window.eval(source) // second evaluation, defineOnce path
    const styles = document.head.querySelectorAll('style[data-redline-styles]')
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toContain(':where(redline-choice')
    expect(styles[0].textContent).toContain('--redline-accent')
  })

  it('ships no daisyui utility classes in rendered markup', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-choice key="k" prompt="p" options="A,B"></redline-choice>
      <redline-approve key="a" prompt="p"></redline-approve>
      <redline-rating key="r" prompt="p" max="3"></redline-rating>
      <redline-ask key="q" prompt="p"></redline-ask>`
    const html = document.body.innerHTML
    for (const cls of ['btn', 'radio', 'checkbox', 'textarea textarea-sm', 'badge', 'mask-star-2', 'rating']) {
      expect(html).not.toMatch(new RegExp(`class="[^"]*\\b${cls}\\b`))
    }
  })
})
```

Note the `loadSdk()` helper installs the binding then evals — reuse it. `beforeEach` must also clear `document.head` of injected styles (add `document.head.querySelectorAll('style[data-redline-styles]').forEach((s) => s.remove())` to the existing beforeEach) so the once-guard test is deterministic.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/static/redline-sdk.test.ts`
Expected: FAIL — no injected style block; DaisyUI classes present.

- [ ] **Step 3: Implement**

In `server/static/redline-sdk.js`:

3a. Add `injectStyles()` and call it once at module top (after the `defineOnce` helper area), guarded:

```js
  const injectStyles = () => {
    if (document.head.querySelector('style[data-redline-styles]')) return
    const style = document.createElement('style')
    style.setAttribute('data-redline-styles', '')
    style.textContent = AURA_CSS
    document.head.append(style)
  }
```

Call `injectStyles()` immediately (top-level, after AURA_CSS definition), not per-component — components may be parsed before any connectedCallback fires.

3b. `AURA_CSS` — the full stylesheet (adapt: this is the approved mock's `.aur` treatment, scoped and generalized; `RL` below abbreviates the five-element selector list `redline-choice, redline-approve, redline-rating, redline-ask, redline-question` — write it out literally in each `:where(...)`):

```css
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) {
  --_ac: var(--redline-accent, #7c6cf6);
  --_ac2: var(--redline-accent2, #5aa9f7);
  display: block; position: relative; isolation: isolate;
  margin: 1.25rem 0; padding: 1.15rem 1.25rem 1.25rem;
  border-radius: 16px;
  background: color-mix(in oklab, currentColor 5%, transparent);
  backdrop-filter: blur(14px);
  font-size: .95rem; line-height: 1.5;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question)::before {
  content: ""; position: absolute; inset: 0; border-radius: 16px; z-index: -1;
  padding: 1px; pointer-events: none;
  background: linear-gradient(135deg, color-mix(in oklab, var(--_ac) 55%, transparent),
              transparent 40%, color-mix(in oklab, var(--_ac2) 45%, transparent));
  -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
  mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question)::after {
  content: ""; position: absolute; z-index: -2; inset: 30% -10% -40% 40%;
  border-radius: 50%; pointer-events: none;
  background: radial-gradient(closest-side, color-mix(in oklab, var(--_ac) 16%, transparent), transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-prompt) {
  margin: 0 0 .85rem; font-weight: 650; letter-spacing: -.01em;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options) {
  display: inline-flex; flex-wrap: wrap; margin: 0 0 .85rem; border-radius: 10px; overflow: hidden;
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label) {
  padding: .45rem 1rem; cursor: pointer; user-select: none; transition: background .14s ease, color .14s ease;
  border-right: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:last-child) {
  border-right: 0;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:hover) {
  background: color-mix(in oklab, currentColor 7%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:has(:checked)) {
  background: linear-gradient(135deg, var(--_ac), var(--_ac2));
  color: #fff; font-weight: 650; text-shadow: 0 1px 4px rgb(0 0 0 / .25);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options input) {
  position: absolute; opacity: 0; pointer-events: none;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment) {
  display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 2.6rem;
  margin: 0 0 .2rem; padding: .55rem .75rem; border-radius: 10px;
  font: inherit; font-size: .9rem; color: inherit; outline: none;
  background: color-mix(in oklab, currentColor 6%, transparent);
  border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  transition: border-color .14s ease, box-shadow .14s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment:focus) {
  border-color: var(--_ac);
  box-shadow: 0 0 18px color-mix(in oklab, var(--_ac) 30%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment::placeholder) {
  color: color-mix(in oklab, currentColor 45%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue) {
  margin-top: .85rem; padding: .5rem 1.15rem; cursor: pointer;
  border: 0; border-radius: 10px; font: inherit; font-size: .9rem; font-weight: 650; color: #fff;
  background: linear-gradient(135deg, var(--_ac), var(--_ac2));
  box-shadow: 0 0 20px color-mix(in oklab, var(--_ac) 40%, transparent), inset 0 1px 0 rgb(255 255 255 / .25);
  transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue:hover:not(:disabled)) {
  transform: translateY(-1px);
  box-shadow: 0 0 28px color-mix(in oklab, var(--_ac) 55%, transparent), inset 0 1px 0 rgb(255 255 255 / .3);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue:disabled) {
  cursor: not-allowed; filter: grayscale(.7) opacity(.55); box-shadow: none;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue[data-queued]) {
  background: linear-gradient(135deg, #2fbf71, #24a05c);
  box-shadow: 0 0 16px rgb(47 191 113 / .35), inset 0 1px 0 rgb(255 255 255 / .25);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-queued-badge) {
  display: inline-block; margin-left: .6rem; padding: .22rem .6rem; border-radius: 999px;
  font-size: .75rem; font-weight: 600; color: #2fbf71;
  background: color-mix(in oklab, #2fbf71 14%, transparent);
  border: 1px solid color-mix(in oklab, #2fbf71 40%, transparent);
  animation: redline-badge-in .25s ease;
}
@keyframes redline-badge-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
```

Embed it as a JS template literal `const AURA_CSS = \`...\`` (no backticks inside — the CSS above has none).

3c. Markup changes (mechanical, in the existing render methods):
- `queueButton`: class becomes just `'redline-queue'`; in `markQueued`, additionally set `button.dataset.queued = '1'` (drives the success style; text change to "Queued ✓" stays).
- `RedlineChoice`/`RedlineApprove`: inputs lose `radio radio-sm`/`checkbox checkbox-sm` (no class needed — inputs are visually hidden by the stylesheet); labels/structure unchanged. Wrap option text in the existing `<span>`/text nodes as-is; ensure the label text node keeps its leading space trimmed or not — visual only, `.textContent`-based tests unaffected.
- `RedlineRating`: replace the classless star inputs with the same label-wrapped pattern the others use so the segmented style applies: each cell becomes `<label><input type="radio" name=… value=…><span>N</span></label>` appended to the `.redline-options` container (drop `mask mask-star-2` and the bare-input append; keep `aria-label`). The existing test queries `host.querySelectorAll('input[type="radio"]')` and clicks `radios[2]` then asserts `3/3` — this still passes with label-wrapped inputs (jsdom routes label-wrapped input .click() the same).
- `RedlineAsk`/`RedlineQuestion`: `redline-comment textarea textarea-sm` → `redline-comment`.
- `.redline-options` container in choice/approve currently `div.redline-options` with block labels — keep the class, the stylesheet now lays it out as the segmented control; remove any `display:block` label styling assumptions (there are none in JS).
- `markQueued` badge: class becomes just `'redline-queued-badge'` (drop `badge badge-success badge-sm`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/static/redline-sdk.test.ts server/redline-api.test.ts && npm run typecheck`
Expected: PASS (api test serves the fatter sdk.js fine).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → all green.

```bash
git add server/static/redline-sdk.js server/static/redline-sdk.test.ts
git commit -m "feat(sdk): aura visual treatment — self-styled components, no kit dependency"
```

---

### Task 2: Doc touches

**Files:**
- Modify: `skills/redline/SKILL.md` (Ready-made review controls section)
- Modify: `skills/redline/playbooks/input.md`

- [ ] **Step 1: Edit both files**

SKILL.md, in the review-controls section, add one sentence where the design kit relationship is described: components are fully self-styled (glass "Aura" look, adapts to dark/light artifacts automatically — the design kit is NOT needed for their appearance) and the accent is overridable by setting `--redline-accent` / `--redline-accent2` on `:root`. Remove/adjust any wording implying components need DaisyUI to look right.

`playbooks/input.md`: same one-liner in its styling-adjacent guidance (components arrive styled; override accents via the two CSS custom properties; artifact CSS can restyle them — the injected rules are zero-specificity).

- [ ] **Step 2: Commit**

```bash
git add skills/redline/SKILL.md skills/redline/playbooks/input.md
git commit -m "docs(skill): components are self-styled; accent override documented"
```

---

### Task 3: Integration check

- [ ] **Step 1:** `npm run typecheck && npm test` — clean, all green.
- [ ] **Step 2:** Commit only if fixes were needed.

(The orchestrator performs the live visual verification — dark + light artifacts, all five components, selected/queued states, accent override — on an isolated stack before merge, per the spec.)
