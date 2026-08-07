# Redline components & response queuing — design

Date: 2026-08-07
Status: approved (brainstorm with Leo)

## Goal

Borrow the rest of what lavish-axi does well — in-artifact input components and
response queuing, an off-the-shelf design kit, per-content-type playbooks — and
improve on it using commando's structural advantages: the daemon can serve
assets locally (no CDN) and CDP gives artifact pages a queue channel with no
network hop and no auth token in the page.

Explicitly **out of scope** (decided in brainstorm):

- Agent replies rendered in the review UI. The agent's terminal beside the tile
  stays the reply channel; the tile keeps its minimal ack footer.
- Full-React artifacts. Artifacts stay single self-contained HTML files; a
  per-artifact build step would slow the revision loop and destabilize
  annotation selectors.
- Lavish's slides playbook, layout-warning detection, export/share.

## Approach (chosen: A — CDP-native transport)

An artifact page embeds ready-made review controls. When the user queues an
answer, it travels page → CDP binding → chromium engine → tile websocket → the
**existing client-side pill queue** in ChromiumTileCard, next to annotation
notes. Nothing reaches the agent until the user presses Send; the existing
`/feedback` POST → store → long-poll drain → drain-is-the-ack pipeline is
unchanged.

Rejected alternatives: HTTP SDK with a capability token (auth surface in
page-land, duplicate queue semantics; "works outside commando" is lavish's
job), and skill-only snippets (no transport — decorated annotations, not
response queuing).

## 1. Daemon serving

Three new **unauthenticated, read-only, GET-only** route groups on the existing
daemon port (daemon binds localhost; content is the user's own):

- `GET /redline/design/*` — design kit served straight out of `node_modules`
  via `require.resolve` (new runtime deps, versions pinned by lockfile, no
  vendored blobs, no copy step):
  - `tailwind.js` → `@tailwindcss/browser` global build
  - `daisyui.css`, `daisyui-themes.css` → `daisyui`
  - `mermaid.mjs` → `mermaid` ESM build
- `GET /redline/sdk.js` — one hand-written vanilla JS file in the repo (no
  build step): custom elements + `window.redline` API.
- `GET /redline/artifacts/<id>/*` — artifact hosting, replacing the skill's
  `python3 -m http.server` step.
  - `POST /api/redline/artifacts {dir}` (agent-token auth, like feedback
    polling) → `{id, url}`; `DELETE /api/redline/artifacts/<id>` unregisters.
  - `id` is random and unguessable. Registrations are in-memory; daemon
    restart means re-register (the skill loop tolerates this).
  - Path safety: resolve and normalize every request path; serve only files
    strictly under the registered directory; no symlink escape; no directory
    listings.

## 2. Transport: CDP bridge & note shape

- The chromium engine registers `Runtime.addBinding {name:
  "__commandoRedlineQueue"}` on every tile page at setup (harmless when
  unused, persists across navigations).
- The SDK calls the binding with a JSON payload. If the binding is absent
  (artifact opened in a plain browser), components render but queueing is
  disabled with a visible hint.
- On `Runtime.bindingCalled` the engine validates at the trust boundary in the
  style of `parseTileInspectResult` — page data is untrusted; length-cap every
  field, drop malformed payloads with a log — then forwards
  `{type: 'page_response', note}` over the tile's existing websocket relay.
- `WebPaneFeedbackNote` gains one optional field:
  `response?: { question: string; answer: string; data?: unknown }`
  (caps ≈ 256 / 1024 / 4096-bytes-JSON). `comment` is always set to a
  human-readable summary ("Plan: Pro") so agents ignorant of the field still
  work; `response` carries the structured answer.
- Payloads carry an optional `queueKey`; a re-answered question **replaces**
  its unsent pill instead of stacking (enforced client-side).

## 3. Components (`/redline/sdk.js`)

Vanilla custom elements, **light DOM** so DaisyUI/artifact CSS applies and
annotation selectors stay ordinary. Discipline (from lavish's input playbook):
interacting updates local state only; an explicit button queues exactly one
structured answer.

- `<redline-question key prompt>` — generic wrapper around any native inputs;
  appends a "Queue answer" button that reads form state and queues once.
- `<redline-choice key prompt options="A,B,C" [multiple]>` — native
  radios/checkboxes.
- `<redline-approve key prompt>` — approve / reject / needs-changes +
  optional comment.
- `<redline-rating key [max=5]>` — numeric rating.
- `<redline-ask key [placeholder]>` — free text.
- `window.redline.queueResponse({question, answer, data?, queueKey?,
  element?})` — public API the elements are built on; computes `selector` and
  `rect` from `element`.

After queueing, the component shows a "queued — see tile footer" badge. Known
v1 asymmetry (accepted): removing the pill in the commando UI does not update
the page badge — no client→page back-channel yet.

## 4. Client UX (ChromiumTileCard)

- `page_response` is accepted **regardless of the review-mode toggle** (the
  toggle governs the annotation overlay; component answers are the page's own
  affordance). Receiving one auto-reveals the footer pill strip.
- Response pills render as `question: answer`, share the queue with annotation
  notes, are removable the same way, and go out in the same Send.
- `queueKey` replacement happens here. Client caps the queue at 50 pills
  (mirroring `MAX_QUEUED_FEEDBACK_NOTES`), dropping the oldest with a console
  warning — spam protection against a misbehaving page.

## 5. Skill & playbooks

- `skills/redline/playbooks/` — adapted (not copied) from lavish: `diagram`
  (Mermaid from the daemon + theme-sync), `comparison`, `table`, `code`,
  `plan`, `input` (rewritten around redline components and the queue
  discipline). SKILL.md gets a playbook router table: must open each matching
  playbook before writing HTML.
- SKILL.md updates: head snippet (design kit + sdk.js at
  `http://127.0.0.1:$COMMANDO_PORT/redline/...`), lavish's design priority
  order made explicit (user's named look → subject project's design system →
  local DaisyUI kit), artifact hosting via the register API, note shape with
  `response`.
- `scripts/commando-serve <dir>` — helper like `commando-feedback`: registers
  the directory, prints the artifact URL; `--stop <id>` unregisters.
- `show-in-commando` SKILL.md: one-line addition documenting the `response`
  field in the note shape.
- Skill edits follow writing-skills RED/GREEN: baseline dry-runs before
  finalizing wording.

## 6. Testing & verification

- Unit (vitest): bridge payload validation; extended `parseFeedbackNotes`;
  queueKey replace logic; artifact-registry path-traversal cases; design-asset
  resolution.
- Live e2e on an isolated stack (separate tmux socket + ports, per project
  memory): author a test artifact with `<redline-choice>` + design kit,
  register it, open the tile, drive a real click via CDP, verify the pill,
  Send, drain via `commando-feedback`, confirm the structured `response`.
- Known tsx pitfall: any new stringified-function code sent to pages needs the
  `__name` shim + string-pin test (see `shared/tile-inspect.ts`).
