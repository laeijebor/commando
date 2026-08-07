# Redline Components & Response Queuing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Artifact pages shown in chromium tiles can embed ready-made review controls whose structured answers queue in the tile's existing pill queue and travel through the existing Send → feedback → drain pipeline; the daemon serves the component SDK, a local design kit (Tailwind/DaisyUI/Mermaid), and registered artifact directories.

**Architecture:** Page → CDP `Runtime.addBinding` → chromium engine (validate at trust boundary) → tile websocket `page_response` → client pill queue → existing `POST /feedback` → store → agent long-poll drain. New unauthenticated GET routes `/redline/*` serve the SDK, design assets (resolved from `node_modules`), and registered artifact dirs; `POST/DELETE /api/redline/artifacts` (agent-token or owner auth) manages registrations. Spec: `docs/superpowers/specs/2026-08-07-redline-components-design.md`.

**Tech Stack:** Node http (no framework), TypeScript under tsx, vitest (jsdom available), vanilla-JS custom elements (light DOM), new runtime deps `@tailwindcss/browser`, `daisyui`, `mermaid`.

## Global Constraints

- Field caps (spec §2): response `question` ≤ 256 chars, `answer` ≤ 1024 chars, `data` ≤ 4096 bytes JSON-serialized, `queueKey` ≤ 128 chars. Reuse `MAX_INSPECT_SELECTOR` (1024), `MAX_INSPECT_TAG` (32), `MAX_INSPECT_TEXT` (512) from `shared/tile-inspect.ts` for selector/tag/text.
- CDP binding name is exactly `__commandoRedlineQueue` (spec §2).
- Client pill queue cap: 50 (spec §4), dropping the oldest.
- All `/redline/*` GET responses: read-only, `X-Content-Type-Options: nosniff`, `Access-Control-Allow-Origin: *` (cross-origin ESM imports of Mermaid need CORS), no directory listings.
- Page data is untrusted: every page-originated payload is validated field-by-field at the engine boundary, malformed payloads dropped silently (spec §2). Same style as `parseTileInspectResult`.
- Nothing reaches the agent without the user pressing Send — the queue is client-side; `WebPaneFeedbackStore` and its drain semantics are unchanged (spec, Approach).
- Artifacts stay plain self-contained HTML; the SDK file is hand-written vanilla JS with no build step (spec §3).
- tsx pitfall: do NOT serialize TS functions with `fn.toString()` for page evaluation (esbuild keepNames injects `__name`). The SDK is a static `.js` file served verbatim, which avoids this entirely. Keep it that way.
- Run all commands from the worktree root `/Users/leoijebor/dev/commando-redline-components`.

---

### Task 1: Shared page-response contract (`shared/redline-response.ts`)

**Files:**
- Create: `shared/redline-response.ts`
- Create: `shared/redline-response.test.ts`

**Interfaces:**
- Consumes: `MAX_INSPECT_SELECTOR`, `MAX_INSPECT_TAG`, `MAX_INSPECT_TEXT` from `shared/tile-inspect.ts`.
- Produces (later tasks import all of these):
  - `REDLINE_BINDING_NAME = '__commandoRedlineQueue'`
  - `MAX_RESPONSE_QUESTION = 256`, `MAX_RESPONSE_ANSWER = 1024`, `MAX_RESPONSE_DATA_JSON = 4096`, `MAX_RESPONSE_QUEUE_KEY = 128`, `MAX_RESPONSE_PAYLOAD_BYTES = 16384`
  - `type RedlinePageResponse = { question: string; answer: string; data?: unknown; queueKey?: string; selector?: string; tag?: string; text?: string; rect?: { x: number; y: number; width: number; height: number } }`
  - `parseRedlinePageResponse(value: unknown): RedlinePageResponse | null`

- [ ] **Step 1: Write the failing test**

Create `shared/redline-response.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  MAX_RESPONSE_QUESTION,
  MAX_RESPONSE_QUEUE_KEY,
  REDLINE_BINDING_NAME,
  parseRedlinePageResponse,
} from './redline-response'

describe('parseRedlinePageResponse', () => {
  const valid = { question: 'Which plan?', answer: 'Pro' }

  it('accepts a minimal response', () => {
    expect(parseRedlinePageResponse(valid)).toEqual({ question: 'Which plan?', answer: 'Pro' })
  })

  it('accepts all optional fields', () => {
    const full = {
      ...valid,
      data: { choice: 'Pro' },
      queueKey: 'plan',
      selector: '#plan-picker',
      tag: 'redline-choice',
      text: 'Plan picker',
      rect: { x: 1, y: 2, width: 30, height: 40 },
    }
    expect(parseRedlinePageResponse(full)).toEqual(full)
  })

  it('rejects non-objects and missing required fields', () => {
    expect(parseRedlinePageResponse(null)).toBeNull()
    expect(parseRedlinePageResponse('hi')).toBeNull()
    expect(parseRedlinePageResponse({ question: 'q' })).toBeNull()
    expect(parseRedlinePageResponse({ answer: 'a' })).toBeNull()
    expect(parseRedlinePageResponse({ question: '', answer: 'a' })).toBeNull()
  })

  it('rejects oversized fields', () => {
    expect(parseRedlinePageResponse({ question: 'q'.repeat(MAX_RESPONSE_QUESTION + 1), answer: 'a' })).toBeNull()
    expect(parseRedlinePageResponse({ question: 'q', answer: 'a'.repeat(MAX_RESPONSE_ANSWER + 1) })).toBeNull()
    expect(parseRedlinePageResponse({ ...valid, queueKey: 'k'.repeat(MAX_RESPONSE_QUEUE_KEY + 1) })).toBeNull()
    expect(
      parseRedlinePageResponse({ ...valid, data: 'd'.repeat(MAX_RESPONSE_DATA_JSON) }),
    ).toBeNull()
  })

  it('rejects unserializable and oversized data', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(parseRedlinePageResponse({ ...valid, data: circular })).toBeNull()
  })

  it('drops malformed optional fields rather than the whole response', () => {
    // Optional presentation fields are best-effort: a bad rect must not lose the answer.
    expect(parseRedlinePageResponse({ ...valid, rect: { x: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, rect: { x: Infinity, y: 0, width: 1, height: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, selector: '' })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, tag: 'x'.repeat(64) })).toEqual(valid)
  })

  it('exports the binding name', () => {
    expect(REDLINE_BINDING_NAME).toBe('__commandoRedlineQueue')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/redline-response.test.ts`
Expected: FAIL — cannot resolve `./redline-response`.

- [ ] **Step 3: Write the implementation**

Create `shared/redline-response.ts`:

```ts
import { MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT } from './tile-inspect.js'

/** Name of the CDP binding the chromium engine installs in every tile page. */
export const REDLINE_BINDING_NAME = '__commandoRedlineQueue'

export const MAX_RESPONSE_QUESTION = 256
export const MAX_RESPONSE_ANSWER = 1_024
export const MAX_RESPONSE_DATA_JSON = 4_096
export const MAX_RESPONSE_QUEUE_KEY = 128
/** Upper bound on the raw binding payload string before JSON.parse. */
export const MAX_RESPONSE_PAYLOAD_BYTES = 16_384

/**
 * A structured answer queued by a redline component inside a tile page.
 * Produced by untrusted page code — parseRedlinePageResponse is the only
 * way one of these enters the daemon.
 */
export type RedlinePageResponse = {
  question: string
  answer: string
  data?: unknown
  queueKey?: string
  selector?: string
  tag?: string
  text?: string
  rect?: { x: number; y: number; width: number; height: number }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validates an untrusted page payload down to the exact forwarded shape.
 * question/answer are load-bearing — reject the payload when they are bad.
 * The presentation extras (selector, tag, text, rect) and data are
 * best-effort: malformed ones are dropped so the answer still gets through.
 */
export function parseRedlinePageResponse(value: unknown): RedlinePageResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!boundedString(record.question, MAX_RESPONSE_QUESTION)) return null
  if (!boundedString(record.answer, MAX_RESPONSE_ANSWER)) return null
  if (record.queueKey !== undefined && !boundedString(record.queueKey, MAX_RESPONSE_QUEUE_KEY)) {
    return null
  }
  const response: RedlinePageResponse = { question: record.question, answer: record.answer }
  if (record.queueKey !== undefined) response.queueKey = record.queueKey as string
  if (record.data !== undefined) {
    let json: string
    try {
      json = JSON.stringify(record.data)
    } catch {
      return null
    }
    if (json === undefined || json.length > MAX_RESPONSE_DATA_JSON) return null
    // Round-trip so the retained value is plain JSON data, not live page objects.
    response.data = JSON.parse(json) as unknown
  }
  if (boundedString(record.selector, MAX_INSPECT_SELECTOR)) response.selector = record.selector
  if (boundedString(record.tag, MAX_INSPECT_TAG)) response.tag = record.tag
  if (boundedString(record.text, MAX_INSPECT_TEXT)) response.text = record.text
  const rect = record.rect as Record<string, unknown> | undefined
  if (
    typeof rect === 'object' && rect !== null &&
    finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
  ) {
    response.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  return response
}
```

Note the test `rejects oversized data` passes `data: 'd'.repeat(MAX_RESPONSE_DATA_JSON)` — its JSON form is 2 chars longer than the cap, so it is rejected; that is intended.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/redline-response.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/redline-response.ts shared/redline-response.test.ts
git commit -m "feat(shared): redline page-response contract with trust-boundary parser"
```

---

### Task 2: `response` field on feedback notes (protocol + API validation)

**Files:**
- Modify: `shared/protocol.ts:280-288` (WebPaneFeedbackNote)
- Modify: `server/web-panes-api.ts:101-136` (parseFeedbackNotes)
- Test: `server/web-panes-api.test.ts` (add cases; file exists)

**Interfaces:**
- Consumes: `MAX_RESPONSE_QUESTION`, `MAX_RESPONSE_ANSWER`, `MAX_RESPONSE_DATA_JSON` from `shared/redline-response.js` (Task 1).
- Produces: `WebPaneFeedbackNote` gains `response?: { question: string; answer: string; data?: unknown }`. Agents see this field verbatim in drained notes. Client (Task 6) relies on the POST accepting it.

- [ ] **Step 1: Write the failing tests**

In `server/web-panes-api.test.ts`, find the existing feedback POST tests (search for `'feedback'` / `parseFeedbackNotes` usage — tests go through `api.handle` with an owner-authenticated POST). Add, following the file's existing helper style:

```ts
it('accepts a note carrying a structured response', async () => {
  // Build a valid note exactly as the existing accept test does, plus:
  // response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } }
  // Assert 200 and that the drained note (via the store the test constructs)
  // contains the response object unchanged.
})

it('rejects a note whose response is malformed', async () => {
  // Same valid note but response: { question: '', answer: 'Pro' } → expect 400.
  // And response: { question: 'q', answer: 'a', data: <string of length 5000> } → expect 400.
  // And response: 'not an object' → expect 400.
})
```

Write these as real tests using the file's existing request/response fakes and note fixtures (copy the nearest valid-note fixture; do not invent new helpers).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/web-panes-api.test.ts`
Expected: the new tests FAIL — `response` is currently stripped (accept test's equality fails) and malformed responses are not rejected.

- [ ] **Step 3: Implement**

In `shared/protocol.ts`, extend the note type:

```ts
/** Structured answer a redline component queued from inside the page. */
export type WebPaneFeedbackResponse = {
  question: string
  answer: string
  data?: unknown
}

export type WebPaneFeedbackNote = {
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  pageUrl: string
  capturedAt: number
  /** Present when the note came from an in-page component, not an annotation. */
  response?: WebPaneFeedbackResponse
}
```

In `server/web-panes-api.ts`, import the caps:

```ts
import { MAX_RESPONSE_ANSWER, MAX_RESPONSE_DATA_JSON, MAX_RESPONSE_QUESTION } from '../shared/redline-response.js'
```

Inside `parseFeedbackNotes`'s map callback, after the existing validation block and before the `return`, add:

```ts
    let response: WebPaneFeedbackNote['response']
    if (note.response !== undefined) {
      const raw = note.response as Record<string, unknown> | null
      if (typeof raw !== 'object' || raw === null) throw new HttpError(400, 'Note response is malformed')
      const question = raw.question
      const answer = raw.answer
      if (
        typeof question !== 'string' || question.length === 0 || question.length > MAX_RESPONSE_QUESTION ||
        typeof answer !== 'string' || answer.length === 0 || answer.length > MAX_RESPONSE_ANSWER
      ) {
        throw new HttpError(400, 'Note response is malformed')
      }
      response = { question, answer }
      if (raw.data !== undefined) {
        let json: string | undefined
        try {
          json = JSON.stringify(raw.data)
        } catch {
          throw new HttpError(400, 'Note response is malformed')
        }
        if (json === undefined || json.length > MAX_RESPONSE_DATA_JSON) {
          throw new HttpError(400, 'Note response is malformed')
        }
        response.data = JSON.parse(json) as unknown
      }
    }
```

and include it in the returned object: `...(response !== undefined ? { response } : {}),`

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/web-panes-api.test.ts shared/redline-response.test.ts`
Expected: PASS (all existing tests too — the field is optional).

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts server/web-panes-api.ts server/web-panes-api.test.ts
git commit -m "feat(server): accept structured response field on feedback notes"
```

---

### Task 3: Engine binding + relay broadcast + wiring

**Files:**
- Modify: `server/chromium-engine.ts` (options at 374-383, `createTarget` at 617-674)
- Modify: `server/web-tile-relay.ts` (add `broadcastPageResponse`)
- Modify: `server/index.ts:430-438` (wire `onPageResponse`)
- Test: `server/web-tile-relay.test.ts` (add broadcast test; file exists)

**Interfaces:**
- Consumes: `REDLINE_BINDING_NAME`, `MAX_RESPONSE_PAYLOAD_BYTES`, `parseRedlinePageResponse`, `RedlinePageResponse` (Task 1).
- Produces:
  - `ChromiumEngineOptions.onPageResponse?: (webPaneId: string, response: RedlinePageResponse) => void`
  - `WebTileRelay.broadcastPageResponse(webPaneId: string, response: RedlinePageResponse): void` — sends `{ type: 'page_response', response }` to every subscribed socket. Client (Task 6) consumes that frame shape.

- [ ] **Step 1: Write the failing relay test**

In `server/web-tile-relay.test.ts`, study how existing tests connect fake sockets through `handleUpgrade`/`connect` (there are fakes for `ChromiumEngine` and `WebPaneService`). Add:

```ts
it('broadcasts page responses to subscribed tile sockets', async () => {
  // Arrange: connect a socket for pane 'w-00000001' exactly like the existing
  // screencast test does. Then:
  relay.broadcastPageResponse('w-00000001', { question: 'Which plan?', answer: 'Pro' })
  // Assert the socket received JSON {type:'page_response', response:{question:'Which plan?', answer:'Pro'}}.
})

it('broadcastPageResponse is a no-op for unknown panes', () => {
  expect(() => relay.broadcastPageResponse('w-deadbeef', { question: 'q', answer: 'a' })).not.toThrow()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/web-tile-relay.test.ts`
Expected: FAIL — `broadcastPageResponse` does not exist.

- [ ] **Step 3: Implement**

`server/web-tile-relay.ts` — add import and method:

```ts
import type { RedlinePageResponse } from '../shared/redline-response.js'
```

```ts
  /** Fans a page-originated component answer out to the tile's viewers. */
  broadcastPageResponse(webPaneId: string, response: RedlinePageResponse): void {
    const sockets = this.subscribers.get(webPaneId)
    if (!sockets) return
    const message = JSON.stringify({ type: 'page_response', response })
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  }
```

`server/chromium-engine.ts` — add to imports:

```ts
import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  REDLINE_BINDING_NAME,
  parseRedlinePageResponse,
  type RedlinePageResponse,
} from '../shared/redline-response.js'
```

Add to `ChromiumEngineOptions`:

```ts
  /** Called when a tile page queues a component answer via the redline binding. */
  onPageResponse?: (webPaneId: string, response: RedlinePageResponse) => void
```

In `createTarget`, immediately after `await cdp.send('Page.enable')` (line ~667), add:

```ts
    // The redline queue binding: page components call
    // window.__commandoRedlineQueue(json) and the payload surfaces here as
    // Runtime.bindingCalled. Installed unconditionally — inert unless a page
    // uses it — and validated as untrusted input before leaving the engine.
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: REDLINE_BINDING_NAME })
    cdp.on('Runtime.bindingCalled', (params) => {
      if (params.name !== REDLINE_BINDING_NAME) return
      const payload = params.payload
      if (typeof payload !== 'string' || payload.length > MAX_RESPONSE_PAYLOAD_BYTES) return
      let value: unknown
      try {
        value = JSON.parse(payload)
      } catch {
        return
      }
      const response = parseRedlinePageResponse(value)
      if (response) this.options.onPageResponse?.(webPaneId, response)
    })
```

`server/index.ts` — the engine is constructed at line 430 and `webTileRelay` at 438. Add to the `new ChromiumEngine({...})` options object:

```ts
    onPageResponse: (webPaneId, response) => webTileRelay.broadcastPageResponse(webPaneId, response),
```

(`webTileRelay` is a `const` declared 8 lines below the engine; the closure only runs on CDP events long after startup, so the reference is safe — do not restructure.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/web-tile-relay.test.ts server/chromium-engine.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/chromium-engine.ts server/web-tile-relay.ts server/index.ts server/web-tile-relay.test.ts
git commit -m "feat(server): CDP redline binding forwards page responses to tile viewers"
```

---

### Task 4: Artifact registry (`server/redline-artifacts.ts`)

**Files:**
- Create: `server/redline-artifacts.ts`
- Create: `server/redline-artifacts.test.ts`

**Interfaces:**
- Consumes: nothing project-internal.
- Produces (Task 5 consumes):
  - `class RedlineArtifactError extends Error { constructor(readonly status: number, message: string) }`
  - `class RedlineArtifactRegistry`:
    - `register(dir: string): { id: string }` — throws `RedlineArtifactError(400|404|429, ...)`
    - `unregister(id: string): boolean`
    - `resolve(id: string, requestPath: string): string | null` — absolute file path, or null (unknown id, traversal, missing file, or directory without index.html)

- [ ] **Step 1: Write the failing tests**

Create `server/redline-artifacts.test.ts`:

```ts
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RedlineArtifactError, RedlineArtifactRegistry } from './redline-artifacts'

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-artifacts-'))
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}')
  return dir
}

describe('RedlineArtifactRegistry', () => {
  it('registers a directory and serves files under it', () => {
    const registry = new RedlineArtifactRegistry()
    const dir = artifactDir()
    const { id } = registry.register(dir)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
    expect(registry.resolve(id, 'assets/app.css')).toBe(join(dir, 'assets', 'app.css'))
  })

  it('serves index.html for the empty path and trailing slash', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(artifactDir())
    expect(registry.resolve(id, '')).toMatch(/index\.html$/)
    expect(registry.resolve(id, 'assets/')).toBeNull() // no assets/index.html
  })

  it('refuses traversal and absolute paths', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(artifactDir())
    expect(registry.resolve(id, '../etc/passwd')).toBeNull()
    expect(registry.resolve(id, 'assets/../../etc/passwd')).toBeNull()
    expect(registry.resolve(id, '/etc/passwd')).toBeNull()
    expect(registry.resolve(id, 'a%2F..%2F..')).toBeNull()
  })

  it('refuses symlinks that escape the registered directory', () => {
    const registry = new RedlineArtifactRegistry()
    const dir = artifactDir()
    symlinkSync('/etc', join(dir, 'escape'))
    const { id } = registry.register(dir)
    expect(registry.resolve(id, 'escape/passwd')).toBeNull()
  })

  it('returns null for unknown ids and missing files', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(artifactDir())
    expect(registry.resolve('0123456789abcdef', 'index.html')).toBeNull()
    expect(registry.resolve(id, 'nope.html')).toBeNull()
  })

  it('rejects bad registrations', () => {
    const registry = new RedlineArtifactRegistry()
    expect(() => registry.register('relative/path')).toThrow(RedlineArtifactError)
    expect(() => registry.register('/definitely/not/a/real/dir-xyz')).toThrow(RedlineArtifactError)
    const filePath = join(artifactDir(), 'index.html')
    expect(() => registry.register(filePath)).toThrow(RedlineArtifactError)
  })

  it('caps registrations at 16', () => {
    const registry = new RedlineArtifactRegistry()
    for (let index = 0; index < 16; index += 1) registry.register(artifactDir())
    expect(() => registry.register(artifactDir())).toThrow(RedlineArtifactError)
  })

  it('unregister frees the id', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(artifactDir())
    expect(registry.unregister(id)).toBe(true)
    expect(registry.unregister(id)).toBe(false)
    expect(registry.resolve(id, 'index.html')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/redline-artifacts.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `server/redline-artifacts.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

const MAX_ARTIFACT_DIRS = 16

export class RedlineArtifactError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * In-memory registry of directories the daemon serves as redline artifacts.
 * Ids are unguessable; resolution is strictly confined to the registered
 * directory — normalized paths AND realpaths must stay inside it, so neither
 * `..` segments nor symlinks can escape.
 */
export class RedlineArtifactRegistry {
  private readonly dirs = new Map<string, string>()

  register(dir: string): { id: string } {
    if (typeof dir !== 'string' || !isAbsolute(dir)) {
      throw new RedlineArtifactError(400, 'dir must be an absolute path')
    }
    if (this.dirs.size >= MAX_ARTIFACT_DIRS) {
      throw new RedlineArtifactError(429, `At most ${MAX_ARTIFACT_DIRS} artifact directories can be registered`)
    }
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      throw new RedlineArtifactError(404, 'dir does not exist')
    }
    if (!statSync(real).isDirectory()) {
      throw new RedlineArtifactError(400, 'dir must be a directory')
    }
    const id = randomBytes(8).toString('hex')
    this.dirs.set(id, real)
    return { id }
  }

  unregister(id: string): boolean {
    return this.dirs.delete(id)
  }

  /** Maps an artifact request path to an absolute file path, or null. */
  resolve(id: string, requestPath: string): string | null {
    const root = this.dirs.get(id)
    if (!root) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      return null
    }
    if (decoded.includes('\0') || isAbsolute(decoded)) return null
    const relative = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded
    const normalized = normalize(relative)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null
    const candidate = resolve(root, normalized)
    if (candidate !== root && !candidate.startsWith(root + sep)) return null
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      return null
    }
    if (real !== root && !real.startsWith(root + sep)) return null
    try {
      if (!statSync(real).isFile()) return null
    } catch {
      return null
    }
    return join(root, normalized)
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/redline-artifacts.test.ts`
Expected: PASS. (On macOS `tmpdir()` involves `/var` → `/private/var` symlinks — `register` stores the realpath, and `resolve` returns paths joined onto that realpath, so the `toBe(join(dir,...))` assertions compare realpath-to-realpath only if `artifactDir()` also realpaths. If the first test fails on the `/private` prefix, fix the TEST to `realpathSync` the dir before comparing — the implementation behavior is correct.)

- [ ] **Step 5: Commit**

```bash
git add server/redline-artifacts.ts server/redline-artifacts.test.ts
git commit -m "feat(server): redline artifact directory registry with path confinement"
```

---

### Task 5: Redline HTTP API — design kit, SDK route, artifact routes (`server/redline-api.ts`)

**Files:**
- Create: `server/redline-api.ts`
- Create: `server/redline-api.test.ts`
- Modify: `package.json` (add deps), `server/index.ts` (mount)
- Create: `server/static/redline-sdk.js` — placeholder only in this task: `/* redline sdk — see Task 6 */\nwindow.redline = window.redline || {};` (Task 6 replaces it)

**Interfaces:**
- Consumes: `RedlineArtifactRegistry`, `RedlineArtifactError` (Task 4).
- Produces:
  - `class RedlineApi` with `constructor(deps: { agentToken: string; ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>; artifacts: RedlineArtifactRegistry; baseUrl: string })` and `handle(request, response, url): Promise<boolean>` (same contract as `WebPanesApi.handle`).
  - `isRedlinePath(pathname: string): boolean` — true for `/redline/...` and `/api/redline/...`.
  - Routes:
    - `GET /redline/sdk.js` → `server/static/redline-sdk.js`
    - `GET /redline/design/tailwind.js` → `@tailwindcss/browser` `dist/index.global.js`
    - `GET /redline/design/daisyui.css`, `GET /redline/design/daisyui-themes.css` → `daisyui` package `daisyui.css` / `themes.css`
    - `GET /redline/design/mermaid/<path>` → files under mermaid's `dist/` (chunk imports resolve here)
    - `GET /redline/artifacts/<id>/<path>` → registry-resolved files
    - `POST /api/redline/artifacts` body `{dir}` (agent or owner) → `201 {ok:true, id, url}` where `url = `${baseUrl}/redline/artifacts/${id}/``
    - `DELETE /api/redline/artifacts/<id>` (agent or owner) → `200 {ok:true}` or 404

- [ ] **Step 1: Add dependencies**

```bash
npm install @tailwindcss/browser@^4 daisyui@^5 mermaid@^11
```

Verify the files this task serves actually exist:

```bash
node -e "const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/x');const {dirname,join}=require('node:path');const root=(n)=>dirname(r.resolve(n+'/package.json'));console.log(join(root('@tailwindcss/browser'),'dist','index.global.js'));console.log(join(root('daisyui'),'daisyui.css'));console.log(join(root('mermaid'),'dist','mermaid.esm.min.mjs'))" | xargs ls -la
```

Expected: three existing files. If `require.resolve('<pkg>/package.json')` throws for any package (exports-map restriction), note which and use this fallback in Step 4's `packageRoot`: resolve the bare specifier instead and walk parent directories until a `package.json` whose `name` matches.

- [ ] **Step 2: Write the failing tests**

Create `server/redline-api.test.ts`. Model request/response fakes on `server/web-panes-api.test.ts` (reuse its minimal `IncomingMessage`/`ServerResponse` stand-ins — copy the smallest fakes it defines rather than importing them). Token: any 32+ char string.

```ts
// Cases (write them all as real tests with the fakes):
// 1. GET /redline/design/daisyui.css → 200, content-type text/css, ACAO *, body length > 0
// 2. GET /redline/design/tailwind.js → 200, content-type text/javascript
// 3. GET /redline/design/mermaid/mermaid.esm.min.mjs → 200, text/javascript
// 4. GET /redline/design/mermaid/../../package.json → 404 (traversal blocked)
// 5. GET /redline/sdk.js → 200, text/javascript
// 6. GET /redline/nope → 404; POST /redline/sdk.js → 405 with Allow: GET
// 7. POST /api/redline/artifacts with agent bearer token and {dir: <real tmp dir>} → 201 {ok,id,url}
//    url === `${baseUrl}/redline/artifacts/${id}/`
// 8. Same POST with no auth → 401; with bad token → 401
// 9. GET /redline/artifacts/<id>/index.html (no auth needed) → 200 text/html
// 10. DELETE /api/redline/artifacts/<id> with agent token → 200; the GET now 404s
// 11. POST /api/redline/artifacts {dir: 'relative'} → 400
// 12. isRedlinePath('/redline/sdk.js') && isRedlinePath('/api/redline/artifacts') true,
//     isRedlinePath('/api/web-panes') false
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run server/redline-api.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

Create `server/redline-api.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RedlineArtifactError, type RedlineArtifactRegistry } from './redline-artifacts.js'

const require_ = createRequire(import.meta.url)
const staticDir = join(dirname(fileURLToPath(import.meta.url)), 'static')

const MAX_REQUEST_BYTES = 16 * 1024
const ARTIFACT_ID = /^[0-9a-f]{16}$/

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function packageRoot(name: string): string {
  return dirname(require_.resolve(`${name}/package.json`))
}

/** Static design-kit files served from node_modules — resolved lazily and cached. */
const designFiles: Record<string, () => string> = {
  'tailwind.js': () => join(packageRoot('@tailwindcss/browser'), 'dist', 'index.global.js'),
  'daisyui.css': () => join(packageRoot('daisyui'), 'daisyui.css'),
  'daisyui-themes.css': () => join(packageRoot('daisyui'), 'themes.css'),
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (!authorization) return null
  return /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null
}

export function isRedlinePath(pathname: string): boolean {
  return pathname === '/redline' || pathname.startsWith('/redline/') ||
    pathname === '/api/redline' || pathname.startsWith('/api/redline/')
}

type RedlineApiDependencies = {
  /** The agent hook token — same secret agents use for the web-panes API. */
  agentToken: string
  ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  artifacts: RedlineArtifactRegistry
  /** Origin artifacts are reachable at, e.g. http://127.0.0.1:4310 */
  baseUrl: string
}

/**
 * Redline routes. `/redline/*` is unauthenticated read-only static serving
 * (the daemon is loopback/tailscale-gated upstream and the content is the
 * user's own artifacts plus public npm assets); `/api/redline/*` mutations
 * require the agent token or owner auth.
 */
export class RedlineApi {
  private readonly agentTokenDigest: Buffer
  private readonly fileCache = new Map<string, Buffer>()

  constructor(private readonly dependencies: RedlineApiDependencies) {
    if (dependencies.agentToken.length < 32) {
      throw new Error('Agent hook token must contain at least 32 characters')
    }
    this.agentTokenDigest = digest(dependencies.agentToken)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isRedlinePath(url.pathname)) return false
    try {
      if (url.pathname.startsWith('/api/redline')) {
        await this.handleApi(request, response, url)
        return true
      }
      this.handleStatic(request, response, url.pathname)
      return true
    } catch (error) {
      if (error instanceof HttpError || error instanceof RedlineArtifactError) {
        if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
        if (error.status === 405) {
          response.setHeader('Allow', url.pathname.startsWith('/api/redline') ? 'POST, DELETE' : 'GET')
        }
        this.writeJson(response, error.status, { error: error.message })
        return true
      }
      this.writeJson(response, 500, { error: 'Redline request failed' })
      return true
    }
  }

  private handleStatic(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
    if (pathname === '/redline/sdk.js') {
      this.serveFile(response, join(staticDir, 'redline-sdk.js'))
      return
    }
    const design = /^\/redline\/design\/([^/]+)$/.exec(pathname)
    if (design && designFiles[design[1]]) {
      this.serveFile(response, designFiles[design[1]]())
      return
    }
    const mermaid = /^\/redline\/design\/mermaid\/(.+)$/.exec(pathname)
    if (mermaid) {
      this.serveTreeFile(response, join(packageRoot('mermaid'), 'dist'), mermaid[1])
      return
    }
    const artifact = /^\/redline\/artifacts\/([0-9a-f]{16})\/(.*)$/.exec(pathname)
    if (artifact) {
      const file = this.dependencies.artifacts.resolve(artifact[1], artifact[2])
      if (!file) throw new HttpError(404, 'Not found')
      // Artifacts change during a review loop — never cache them.
      this.serveFile(response, file, { cache: 'no-store', cached: false })
      return
    }
    throw new HttpError(404, 'Not found')
  }

  /** Serves a file strictly under a root directory (for mermaid's chunk tree). */
  private serveTreeFile(response: ServerResponse, root: string, requestPath: string): void {
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      throw new HttpError(404, 'Not found')
    }
    const normalized = normalize(decoded)
    if (normalized.includes('\0') || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith(sep)) {
      throw new HttpError(404, 'Not found')
    }
    this.serveFile(response, join(root, normalized))
  }

  private serveFile(
    response: ServerResponse,
    filePath: string,
    options: { cache?: string; cached?: boolean } = {},
  ): void {
    const cached = options.cached ?? true
    let body = cached ? this.fileCache.get(filePath) : undefined
    if (!body) {
      try {
        body = readFileSync(filePath)
      } catch {
        throw new HttpError(404, 'Not found')
      }
      if (cached) this.fileCache.set(filePath, body)
    }
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': options.cache ?? 'public, max-age=300',
      'Content-Length': body.length,
      'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    await this.authenticate(request, url)
    if (url.pathname === '/api/redline/artifacts') {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const body = await this.readJson(request)
      if (typeof body.dir !== 'string') throw new HttpError(400, 'dir must be a string')
      const { id } = this.dependencies.artifacts.register(body.dir)
      this.writeJson(response, 201, {
        ok: true,
        id,
        url: `${this.dependencies.baseUrl}/redline/artifacts/${id}/`,
      })
      return
    }
    const single = /^\/api\/redline\/artifacts\/([0-9a-f]{16})$/.exec(url.pathname)
    if (single && ARTIFACT_ID.test(single[1])) {
      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      if (!this.dependencies.artifacts.unregister(single[1])) throw new HttpError(404, 'Not found')
      this.writeJson(response, 200, { ok: true })
      return
    }
    throw new HttpError(404, 'Not found')
  }

  private async authenticate(request: IncomingMessage, url: URL): Promise<void> {
    if (await this.dependencies.ownerAuthorized(request, url)) return
    const candidate = bearerToken(request)
    if (
      candidate !== null && candidate.length <= 1_024 &&
      timingSafeEqual(digest(candidate), this.agentTokenDigest)
    ) {
      return
    }
    throw new HttpError(401, 'Unauthorized')
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    const body = `${JSON.stringify(value)}\n`
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
    const chunks: Buffer[] = []
    let byteLength = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += buffer.length
      if (byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, 'Request body is too large')
      chunks.push(buffer)
    }
    if (byteLength === 0) throw new HttpError(400, 'Request body is required')
    let value: unknown
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'Request body must be a JSON object')
    }
    return value as Record<string, unknown>
  }
}
```

Create `server/static/redline-sdk.js` with placeholder content (Task 6 replaces it):

```js
/* redline sdk — full implementation lands with the component library task */
window.redline = window.redline || {}
```

Mount in `server/index.ts`: near the `webPanesApi` construction (line ~1162 area), construct:

```ts
  const redlineArtifacts = new RedlineArtifactRegistry()
  const redlineApi = new RedlineApi({
    agentToken,
    ownerAuthorized: (request, url) => requestIsAuthorized(request, url),
    artifacts: redlineArtifacts,
    baseUrl: `http://127.0.0.1:${port}`,
  })
```

(Find the exact names: `webPanesApi`'s constructor call shows how the agent token and owner-auth callback are obtained there — reuse the same expressions. `port` is the daemon's listen port variable used elsewhere in `index.ts`; find it with `grep -n "COMMANDO_PORT" server/index.ts`.)

In `requestListener` (line 1593), add after the `webPanesApi` line:

```ts
      if (await redlineApi.handle(request, response, url)) return
```

This runs before the generic `/api/` owner gate, which is required for agent-token POSTs — mirror how `webPanesApi` sits there. Add the imports for `RedlineApi` and `RedlineArtifactRegistry` at the top of `index.ts`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run server/redline-api.test.ts server/redline-artifacts.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/redline-api.ts server/redline-api.test.ts server/static/redline-sdk.js server/index.ts
git commit -m "feat(server): redline routes — local design kit, sdk, artifact hosting"
```

---

### Task 6: The component SDK (`server/static/redline-sdk.js`)

**Files:**
- Replace: `server/static/redline-sdk.js` (placeholder from Task 5)
- Create: `server/static/redline-sdk.test.ts`

**Interfaces:**
- Consumes: the CDP binding `window.__commandoRedlineQueue(payload: string)` (installed by Task 3; absent outside commando tiles).
- Produces (page-side, documented for the skill in Task 8):
  - `window.redline.queueResponse(input: { question, answer, data?, queueKey?, element? }): boolean`
  - Custom elements: `<redline-question>`, `<redline-choice>`, `<redline-approve>`, `<redline-rating>`, `<redline-ask>`.

- [ ] **Step 1: Write the failing tests**

Create `server/static/redline-sdk.test.ts`:

```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(join(__dirname, 'redline-sdk.js'), 'utf8')

type QueueCall = { question: string; answer: string; data?: unknown; queueKey?: string; selector?: string; tag?: string; rect?: unknown }

function loadSdk(): QueueCall[] {
  const calls: QueueCall[] = []
  ;(window as unknown as Record<string, unknown>).__commandoRedlineQueue = (payload: string) => {
    calls.push(JSON.parse(payload) as QueueCall)
  }
  // eslint-disable-next-line no-eval -- executing the served asset under test
  window.eval(source)
  return calls
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete (window as unknown as Record<string, unknown>).__commandoRedlineQueue
  delete (window as unknown as Record<string, unknown>).redline
})

describe('window.redline.queueResponse', () => {
  it('serializes the payload through the binding', () => {
    const calls = loadSdk()
    const target = document.createElement('div')
    target.id = 'target'
    document.body.append(target)
    const ok = (window as any).redline.queueResponse({
      question: 'Which plan?',
      answer: 'Pro',
      data: { choice: 'Pro' },
      queueKey: 'plan',
      element: target,
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].question).toBe('Which plan?')
    expect(calls[0].answer).toBe('Pro')
    expect(calls[0].queueKey).toBe('plan')
    expect(calls[0].selector).toBe('#target')
    expect(calls[0].tag).toBe('div')
    expect(calls[0].rect).toBeDefined()
  })

  it('returns false without the binding', () => {
    window.eval(source)
    expect((window as any).redline.queueResponse({ question: 'q', answer: 'a' })).toBe(false)
  })
})

describe('redline-choice', () => {
  it('renders options and queues only on the explicit button', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const radios = host.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    const button = host.querySelector('button') as HTMLButtonElement
    ;(radios[1] as HTMLInputElement).click()
    expect(calls).toHaveLength(0) // selection alone must not queue
    button.click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'Which plan?', answer: 'Pro', queueKey: 'plan' })
    expect(host.textContent).toContain('queued')
  })

  it('does nothing when no option is selected', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="plan" prompt="Which plan?" options="A,B"></redline-choice>'
    ;(document.querySelector('redline-choice button') as HTMLButtonElement).click()
    expect(calls).toHaveLength(0)
  })

  it('supports multiple selection', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="feat" prompt="Keep which?" options="A,B,C" multiple></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const boxes = host.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    ;(boxes[0] as HTMLInputElement).click()
    ;(boxes[2] as HTMLInputElement).click()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0].answer).toBe('A, C')
  })
})

describe('redline-approve', () => {
  it('queues verdict with optional comment', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-approve key="hero" prompt="Hero section ok?"></redline-approve>'
    const host = document.querySelector('redline-approve') as HTMLElement
    const reject = [...host.querySelectorAll('input[type="radio"]')].find(
      (input) => (input as HTMLInputElement).value === 'reject',
    ) as HTMLInputElement
    reject.click()
    const comment = host.querySelector('textarea') as HTMLTextAreaElement
    comment.value = 'too loud'
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'Hero section ok?', answer: 'reject — too loud', queueKey: 'hero' })
    expect(calls[0].data).toMatchObject({ verdict: 'reject', comment: 'too loud' })
  })
})

describe('redline-rating', () => {
  it('queues the selected numeric rating', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-rating key="vibe" prompt="Rate the vibe" max="3"></redline-rating>'
    const host = document.querySelector('redline-rating') as HTMLElement
    const radios = host.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(3)
    ;(radios[2] as HTMLInputElement).click()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'Rate the vibe', answer: '3/3', queueKey: 'vibe' })
  })
})

describe('redline-ask', () => {
  it('queues free text', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-ask key="name" prompt="What should we call it?"></redline-ask>'
    const host = document.querySelector('redline-ask') as HTMLElement
    ;(host.querySelector('textarea') as HTMLTextAreaElement).value = 'Redline'
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'What should we call it?', answer: 'Redline', queueKey: 'name' })
  })
})

describe('redline-question', () => {
  it('collects values from wrapped native inputs', () => {
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-question key="opts" prompt="Configure it">
        <label>Port <input name="port" value="4310"></label>
        <label><input type="checkbox" name="tls" checked> TLS</label>
      </redline-question>`
    const host = document.querySelector('redline-question') as HTMLElement
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0].question).toBe('Configure it')
    expect(calls[0].answer).toContain('port: 4310')
    expect(calls[0].answer).toContain('tls: yes')
    expect(calls[0].data).toMatchObject({ port: '4310', tls: true })
  })
})

describe('binding-absent fallback', () => {
  it('disables queue buttons with a hint', () => {
    window.eval(source) // no binding installed
    document.body.innerHTML = '<redline-choice key="k" prompt="p" options="A,B"></redline-choice>'
    const button = document.querySelector('redline-choice button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title.toLowerCase()).toContain('commando')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/static/redline-sdk.test.ts`
Expected: FAIL — the placeholder SDK defines nothing.

- [ ] **Step 3: Implement the SDK**

Replace `server/static/redline-sdk.js` with:

```js
/**
 * Redline component SDK — served by the commando daemon at /redline/sdk.js.
 * Plain JS on purpose: artifacts load it with one <script> tag and it must
 * work with no build step. Inside a commando chromium tile the CDP binding
 * window.__commandoRedlineQueue exists; elsewhere components render but
 * queueing is disabled.
 *
 * Discipline (matters for review UX): interacting with a control only updates
 * local state. Only the explicit queue button sends, exactly once per press,
 * and a queueKey makes re-answers replace the unsent previous answer.
 */
;(() => {
  'use strict'
  const BINDING = '__commandoRedlineQueue'

  const bindingAvailable = () => typeof window[BINDING] === 'function'

  /** id → data-testid → nth-of-type path, mirroring the tile inspector. */
  const cssPath = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`
    const testId = element.getAttribute && element.getAttribute('data-testid')
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`
    const parts = []
    let node = element
    while (node && node.nodeType === 1 && parts.length < 32) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      const tag = node.tagName.toLowerCase()
      let index = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1
        sibling = sibling.previousElementSibling
      }
      parts.unshift(`${tag}:nth-of-type(${index})`)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const queueResponse = (input) => {
    if (!input || typeof input.question !== 'string' || typeof input.answer !== 'string') return false
    const payload = {
      question: input.question.slice(0, 256),
      answer: input.answer.slice(0, 1024),
    }
    if (input.data !== undefined) payload.data = input.data
    if (typeof input.queueKey === 'string' && input.queueKey.length > 0) {
      payload.queueKey = input.queueKey.slice(0, 128)
    }
    const element = input.element instanceof Element ? input.element : null
    if (element) {
      const selector = cssPath(element)
      if (selector) payload.selector = selector.slice(0, 1024)
      payload.tag = element.tagName.toLowerCase().slice(0, 32)
      const rect = element.getBoundingClientRect()
      payload.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const text = (element.textContent || '').trim()
      if (text) payload.text = text.slice(0, 512)
    }
    if (!bindingAvailable()) {
      console.warn('redline: not inside a commando tile — answer not queued', payload)
      return false
    }
    try {
      window[BINDING](JSON.stringify(payload))
    } catch (error) {
      console.warn('redline: failed to queue answer', error)
      return false
    }
    return true
  }

  window.redline = Object.assign(window.redline || {}, { queueResponse })

  let uid = 0
  const nextName = () => `redline-${(uid += 1)}`

  const queueButton = (label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'redline-queue btn btn-primary btn-sm'
    button.textContent = label || 'Queue answer'
    if (!bindingAvailable()) {
      button.disabled = true
      button.title = 'Open this page in a commando tile to queue answers'
    }
    return button
  }

  const markQueued = (host, button) => {
    button.textContent = 'Queued ✓'
    let badge = host.querySelector('.redline-queued-badge')
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'redline-queued-badge badge badge-success badge-sm'
      badge.textContent = 'queued — see tile footer'
      button.after(badge)
    }
  }

  const promptHeading = (host) => {
    const heading = document.createElement('p')
    heading.className = 'redline-prompt'
    heading.textContent = host.getAttribute('prompt') || ''
    return heading
  }

  /** Shared base: light-DOM render on connect, one queue press per answer. */
  class RedlineElement extends HTMLElement {
    connectedCallback() {
      if (this.dataset.redlineReady) return
      this.dataset.redlineReady = '1'
      this.render()
    }
    key() {
      return this.getAttribute('key') || undefined
    }
    prompt() {
      return this.getAttribute('prompt') || this.getAttribute('key') || 'Question'
    }
    queue(answer, data) {
      const sent = queueResponse({
        question: this.prompt(),
        answer,
        data,
        queueKey: this.key(),
        element: this,
      })
      if (sent) markQueued(this, this.querySelector('button.redline-queue'))
      return sent
    }
    render() {}
  }

  class RedlineChoice extends RedlineElement {
    render() {
      const multiple = this.hasAttribute('multiple')
      const name = nextName()
      const options = (this.getAttribute('options') || '')
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean)
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options'
      for (const option of options) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = multiple ? 'checkbox' : 'radio'
        input.name = name
        input.value = option
        input.className = multiple ? 'checkbox checkbox-sm' : 'radio radio-sm'
        label.append(input, document.createTextNode(` ${option}`))
        list.append(label)
      }
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const chosen = [...this.querySelectorAll('input:checked')].map((input) => input.value)
        if (chosen.length === 0) return
        this.queue(chosen.join(', '), { choice: multiple ? chosen : chosen[0] })
      })
      this.append(list, button)
    }
  }

  class RedlineApprove extends RedlineElement {
    render() {
      const name = nextName()
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options'
      for (const verdict of ['approve', 'reject', 'needs-changes']) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = name
        input.value = verdict
        input.className = 'radio radio-sm'
        label.append(input, document.createTextNode(` ${verdict}`))
        list.append(label)
      }
      const comment = document.createElement('textarea')
      comment.className = 'redline-comment textarea textarea-sm'
      comment.placeholder = 'Optional comment'
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        const note = comment.value.trim()
        this.queue(note ? `${selected.value} — ${note}` : selected.value, {
          verdict: selected.value,
          ...(note ? { comment: note } : {}),
        })
      })
      this.append(list, comment, button)
    }
  }

  class RedlineRating extends RedlineElement {
    render() {
      const name = nextName()
      const max = Math.min(Math.max(Number(this.getAttribute('max')) || 5, 2), 10)
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options rating'
      for (let value = 1; value <= max; value += 1) {
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = name
        input.value = String(value)
        input.className = 'mask mask-star-2'
        input.setAttribute('aria-label', `${value} of ${max}`)
        list.append(input)
      }
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        this.queue(`${selected.value}/${max}`, { rating: Number(selected.value), max })
      })
      this.append(list, button)
    }
  }

  class RedlineAsk extends RedlineElement {
    render() {
      this.append(promptHeading(this))
      const input = document.createElement('textarea')
      input.className = 'redline-comment textarea textarea-sm'
      input.placeholder = this.getAttribute('placeholder') || 'Your answer'
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const answer = input.value.trim()
        if (!answer) return
        this.queue(answer)
      })
      this.append(input, button)
    }
  }

  class RedlineQuestion extends RedlineElement {
    render() {
      // Wraps author-provided native inputs; only adds the heading + button.
      this.prepend(promptHeading(this))
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const data = {}
        const parts = []
        for (const field of this.querySelectorAll('input, select, textarea')) {
          const key = field.name || field.id
          if (!key) continue
          if (field.type === 'checkbox') {
            data[key] = field.checked
            parts.push(`${key}: ${field.checked ? 'yes' : 'no'}`)
          } else if (field.type === 'radio') {
            if (!field.checked) continue
            data[key] = field.value
            parts.push(`${key}: ${field.value}`)
          } else {
            data[key] = field.value
            parts.push(`${key}: ${field.value}`)
          }
        }
        if (parts.length === 0) return
        this.queue(parts.join('; ').slice(0, 1024), data)
      })
      this.append(button)
    }
  }

  customElements.define('redline-choice', RedlineChoice)
  customElements.define('redline-approve', RedlineApprove)
  customElements.define('redline-rating', RedlineRating)
  customElements.define('redline-ask', RedlineAsk)
  customElements.define('redline-question', RedlineQuestion)
})()
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/static/redline-sdk.test.ts server/redline-api.test.ts`
Expected: PASS (including the api test that serves the now-real sdk.js).

- [ ] **Step 5: Commit**

```bash
git add server/static/redline-sdk.js server/static/redline-sdk.test.ts
git commit -m "feat(sdk): vanilla redline review components with response queuing"
```

---

### Task 7: Client — page responses join the pill queue

**Files:**
- Modify: `src/tileReview.ts`
- Modify: `src/tileReview.test.ts`
- Modify: `src/ChromiumTileCard.tsx` (message handler ~line 170-186; `submitQueued` ~line 316)

**Interfaces:**
- Consumes: `parseRedlinePageResponse`, `RedlinePageResponse` (Task 1); relay frame `{type:'page_response', response}` (Task 3); `WebPaneFeedbackNote.response` (Task 2).
- Produces:
  - `QueuedReviewNote` gains `queueKey?: string` and `response?: { question: string; answer: string; data?: unknown }`
  - `MAX_QUEUED_PILLS = 50`
  - `queuePageResponse(list: QueuedReviewNote[], response: RedlinePageResponse, id: number): QueuedReviewNote[]`
  - `toFeedbackNotes` forwards `response`.

- [ ] **Step 1: Write the failing tests**

Add to `src/tileReview.test.ts`:

```ts
import { queuePageResponse, MAX_QUEUED_PILLS } from './tileReview'

describe('queuePageResponse', () => {
  const response = { question: 'Which plan?', answer: 'Pro', queueKey: 'plan' }

  it('appends a pill note with a readable comment', () => {
    const list = queuePageResponse([], response, 1)
    expect(list).toHaveLength(1)
    expect(list[0].comment).toBe('Which plan?: Pro')
    expect(list[0].response).toEqual({ question: 'Which plan?', answer: 'Pro' })
    expect(list[0].queueKey).toBe('plan')
    expect(list[0].selector).toBe('redline:plan')
    expect(list[0].tag).toBe('redline')
  })

  it('uses page-provided selector/tag/rect when present', () => {
    const list = queuePageResponse(
      [],
      { ...response, selector: '#picker', tag: 'redline-choice', rect: { x: 1, y: 2, width: 3, height: 4 } },
      1,
    )
    expect(list[0].selector).toBe('#picker')
    expect(list[0].tag).toBe('redline-choice')
    expect(list[0].rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('replaces an unsent answer with the same queueKey', () => {
    const first = queuePageResponse([], response, 1)
    const second = queuePageResponse(first, { ...response, answer: 'Starter' }, 2)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(2)
    expect(second[0].comment).toBe('Which plan?: Starter')
  })

  it('keeps distinct queueKeys and keyless answers separate', () => {
    const first = queuePageResponse([], response, 1)
    const second = queuePageResponse(first, { question: 'q2', answer: 'a2' }, 2)
    const third = queuePageResponse(second, { question: 'q3', answer: 'a3' }, 3)
    expect(third).toHaveLength(3)
  })

  it('carries data through to feedback notes', () => {
    const list = queuePageResponse([], { ...response, data: { choice: 'Pro' } }, 1)
    const notes = toFeedbackNotes(list, 'http://x/', 42)
    expect(notes[0].response).toEqual({ question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } })
    expect(notes[0]).not.toHaveProperty('queueKey')
    expect(notes[0]).not.toHaveProperty('id')
  })

  it('caps the queue at MAX_QUEUED_PILLS dropping the oldest', () => {
    let list: ReturnType<typeof queuePageResponse> = []
    for (let index = 0; index < MAX_QUEUED_PILLS + 5; index += 1) {
      list = queuePageResponse(list, { question: `q${index}`, answer: 'a' }, index)
    }
    expect(list).toHaveLength(MAX_QUEUED_PILLS)
    expect(list[0].comment).toBe('q5: a')
  })
})
```

(Adjust the import line to merge with the file's existing imports; `toFeedbackNotes` is already imported there.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/tileReview.test.ts`
Expected: FAIL — `queuePageResponse` not exported.

- [ ] **Step 3: Implement `tileReview.ts` changes**

```ts
import type { RedlinePageResponse } from '../shared/redline-response'
```

Extend the type:

```ts
export type QueuedReviewNote = {
  id: number
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  /** Replace-key for unsent re-answers from the same in-page question. */
  queueKey?: string
  /** Structured answer when the note came from an in-page component. */
  response?: { question: string; answer: string; data?: unknown }
}

export const MAX_QUEUED_PILLS = 50

/**
 * Queues an in-page component answer as a pill note. A queueKey match
 * replaces the unsent previous answer (lavish's replace-not-stack rule);
 * the cap drops the oldest so a misbehaving page cannot grow the queue
 * without bound.
 */
export function queuePageResponse(
  list: QueuedReviewNote[],
  response: RedlinePageResponse,
  id: number,
): QueuedReviewNote[] {
  const kept = response.queueKey === undefined
    ? list
    : list.filter((note) => note.queueKey !== response.queueKey)
  const note: QueuedReviewNote = {
    id,
    selector: response.selector ?? `redline:${response.queueKey ?? response.question.slice(0, 64)}`,
    tag: response.tag ?? 'redline',
    ...(response.text !== undefined ? { text: response.text } : {}),
    rect: response.rect ?? { x: 0, y: 0, width: 0, height: 0 },
    comment: `${response.question}: ${response.answer}`,
    ...(response.queueKey !== undefined ? { queueKey: response.queueKey } : {}),
    response: {
      question: response.question,
      answer: response.answer,
      ...(response.data !== undefined ? { data: response.data } : {}),
    },
  }
  return [...kept, note].slice(-MAX_QUEUED_PILLS)
}
```

Update `toFeedbackNotes` to strip the new client-only field and forward `response`:

```ts
export function toFeedbackNotes(
  list: QueuedReviewNote[],
  pageUrl: string,
  now: number,
): WebPaneFeedbackNote[] {
  return list.map(({ id: _id, queueKey: _queueKey, ...note }) => ({ ...note, pageUrl, capturedAt: now }))
}
```

(`response` passes through the rest spread; `WebPaneFeedbackNote` accepts it since Task 2. The comment cap: question ≤256 + ': ' + answer ≤1024 stays under the server's 4096 comment cap — no truncation needed.)

- [ ] **Step 4: Run to verify pass, then wire the card**

Run: `npx vitest run src/tileReview.test.ts` → PASS.

In `src/ChromiumTileCard.tsx`:

Add imports: `queuePageResponse` from `./tileReview`, `parseRedlinePageResponse` from `../shared/redline-response`.

In the socket message handler (after the `inspect_result` branch at line ~174), add:

```ts
        if (message.type === 'page_response') {
          const response = parseRedlinePageResponse(message.response)
          if (response) {
            setQueued((current) => queuePageResponse(current, response, nextNoteId.current++))
          }
          return
        }
```

(Re-validating on the client is deliberate: the frame crossed a socket, and the parse doubles as the type guard.) No pill-strip change is needed — it already renders whenever `queued.length > 0` (line 455), independent of the review toggle, which is exactly the spec §4 behavior.

- [ ] **Step 5: Full client tests + typecheck**

Run: `npx vitest run src/ && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/tileReview.ts src/tileReview.test.ts src/ChromiumTileCard.tsx
git commit -m "feat(client): page component answers queue as review pills with queueKey replace"
```

---

### Task 8: `scripts/commando-serve` helper

**Files:**
- Create: `scripts/commando-serve` (mode 755)

**Interfaces:**
- Consumes: `POST/DELETE /api/redline/artifacts` (Task 5), token/port conventions from `scripts/commando-feedback`.
- Produces: CLI used by the redline skill (Task 9): `commando-serve <dir>` prints `{"ok":true,"id":...,"url":...}`; `commando-serve --stop <id>`.

- [ ] **Step 1: Write the script**

Create `scripts/commando-serve`:

```bash
#!/usr/bin/env bash
# commando-serve — host a directory as a redline artifact via the daemon.
#
#   commando-serve <dir>        register; prints {"ok":true,"id":"...","url":"..."}
#   commando-serve --stop <id>  unregister
#
# The daemon serves the directory read-only at the printed url (index.html at
# the root). Registrations are in-memory: after a daemon restart, re-register.
# Exit codes: 0 success, 2 usage, 1 other errors.
set -euo pipefail

mode="register"
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stop)
      mode="stop"
      target="${2:-}"
      shift 2 || { echo "commando-serve: --stop needs an artifact id" >&2; exit 2; }
      ;;
    -*)
      echo "commando-serve: unknown flag $1" >&2
      exit 2
      ;;
    *)
      target="$1"
      shift
      ;;
  esac
done
if [ -z "$target" ]; then
  echo "usage: commando-serve <dir> | commando-serve --stop <id>" >&2
  exit 2
fi

token_path="${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}"
if [ ! -f "$token_path" ]; then
  echo "commando-serve: agent hook token not found at $token_path" >&2
  exit 1
fi
token="$(cat "$token_path")"
port="${COMMANDO_PORT:-4310}"
base="http://127.0.0.1:${port}"

body_file=$(mktemp "${TMPDIR:-/tmp}/commando-serve-body.XXXXXX")
trap 'rm -f "$body_file"' EXIT

if [ "$mode" = "stop" ]; then
  status=$(curl -sS -o "$body_file" -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${token}" \
    "${base}/api/redline/artifacts/${target}")
else
  dir="$(cd "$target" 2>/dev/null && pwd)" || {
    echo "commando-serve: $target is not a directory" >&2
    exit 1
  }
  status=$(curl -sS -o "$body_file" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -d "{\"dir\":$(printf '%s' "$dir" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
    "${base}/api/redline/artifacts")
fi

cat "$body_file"
echo
case "$status" in
  200|201) exit 0 ;;
  *)
    echo "commando-serve: daemon responded ${status}" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x scripts/commando-serve
```

- [ ] **Step 2: Verify usage errors (no daemon needed)**

Run: `scripts/commando-serve` → expect usage line, exit 2. Run `scripts/commando-serve --bogus` → unknown flag, exit 2. (Full round-trip is covered in the final live e2e.)

- [ ] **Step 3: Commit**

```bash
git add scripts/commando-serve
git commit -m "feat(scripts): commando-serve registers artifact dirs with the daemon"
```

---

### Task 9: Skill + playbooks + installer

**Files:**
- Modify: `skills/redline/SKILL.md`
- Create: `skills/redline/playbooks/diagram.md`, `comparison.md`, `table.md`, `code.md`, `plan.md`, `input.md`
- Modify: `skills/show-in-commando/SKILL.md` (note shape)
- Modify: `scripts/install-show-in-commando-skill` (copy whole skill dirs)

This task is content-authoring; there is no vitest cycle. Correctness gate: the section-by-section requirements below plus reviewer sign-off. (The orchestrator runs skill-TDD baselines separately after the build.)

- [ ] **Step 1: Update the installer to copy whole skill directories**

In `scripts/install-show-in-commando-skill`, replace the copy line:

```bash
    mkdir -p "$root/$name"
    cp -R "$skill_dir"/. "$root/$name/"
    echo "installed $root/$name"
```

(The `cp "$skill_dir/SKILL.md"` line goes away; playbooks now ship too.)

- [ ] **Step 2: Rewrite `skills/redline/SKILL.md` section 1 and add components/playbooks sections**

Keep the existing frontmatter, title, REQUIRED SUB-SKILL preamble, and sections 2–4 except where noted. Changes:

**Section 1 (“Get a URL”)** — replace the python http.server flow:
- Authored artifacts still go in `.redline/<topic>.html` with stable section `id`s.
- Serve via the daemon instead: `scripts/commando-serve .redline` (in the commando repo; otherwise `curl -sS -X POST -H "Authorization: Bearer $(cat ~/.commando/agent-hook-token)" -H 'Content-Type: application/json' -d "{\"dir\":\"$PWD/.redline\"}" "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/redline/artifacts"`). The returned `url` + filename is the tile URL. No port picking, no separate server process. Registrations are in-memory — if the daemon restarts mid-review, re-register.
- Design priority order (make it explicit, three steps): (1) the user named a look → use it; (2) else inspect the subject project and match its design system; (3) else use the daemon-served kit:

```html
<link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui.css">
<link rel="stylesheet" href="http://127.0.0.1:4310/redline/design/daisyui-themes.css">
<script src="http://127.0.0.1:4310/redline/design/tailwind.js"></script>
```

(substitute `$COMMANDO_PORT` if set; served locally by the daemon — no CDN, works offline).

**New section: “Ready-made review controls (response queuing)”** — document:
- Load the SDK: `<script src="http://127.0.0.1:4310/redline/sdk.js"></script>`.
- The five elements with one-line usage each and a full example:

```html
<redline-choice key="plan" prompt="Which plan should we build?" options="Starter,Pro,Enterprise"></redline-choice>
<redline-approve key="hero" prompt="Hero section direction ok?"></redline-approve>
<redline-rating key="vibe" prompt="How close is the visual style?" max="5"></redline-rating>
<redline-ask key="naming" prompt="Better name for this feature?"></redline-ask>
<redline-question key="config" prompt="Tune the defaults">
  <label>Poll seconds <input name="poll" value="30"></label>
</redline-question>
```

- Semantics the agent must know: selecting only updates local state; the explicit "Queue answer" button queues; answers land in the tile's pill strip next to annotations and arrive ONLY when the user presses Send; a re-answer with the same `key` replaces the unsent one; `window.redline.queueResponse({question, answer, data?, queueKey?, element?})` exists for custom controls.
- Notes that carry a component answer have a `response: {question, answer, data?}` field — prefer it over parsing `comment`.
- Use controls for decisions the user can make faster by clicking than typing; use plain annotation for open-ended feedback (lavish's rule).

**New section: “Playbooks”** — router table; instruction: MUST read each matching playbook file (relative to this skill's directory) before writing artifact HTML:

| playbook | use when |
|---|---|
| `playbooks/diagram.md` | flows, architecture, state, sequences |
| `playbooks/comparison.md` | options, tradeoffs, current vs target |
| `playbooks/table.md` | dense records needing scan-friendly review |
| `playbooks/code.md` | source, patches, diffs, before/after code |
| `playbooks/plan.md` | product/technical plan for review |
| `playbooks/input.md` | collecting decisions/choices/triage from the user |

**Section 3 (loop)**: add one bullet — notes may be component answers (`response` field present); acknowledge them in the terminal reply like annotation notes.

**Section 4 (stop)**: add — unregister the artifact dir (`scripts/commando-serve --stop <id>`) alongside closing the tile; the artifact file remains the deliverable.

- [ ] **Step 3: Write the six playbooks**

Each ≤60 lines, same voice as SKILL.md, adapted from lavish's ideas but commando-native. Required content per file:

- `diagram.md`: use Mermaid, never hand-built div/flexbox boxes; module import from the daemon: `import mermaid from "http://127.0.0.1:4310/redline/design/mermaid/mermaid.esm.min.mjs"`; init with `startOnLoad:false` + `securityLevel:'strict'` and render into `.mermaid` nodes; match page theme (dark theme when the artifact is dark); keep node labels short, expand detail in surrounding prose; sequence for interactions, flowchart for structure, state for lifecycles.
- `comparison.md`: side-by-side cards or a criteria×options table, one row per decision-relevant criterion only; verdict row at the bottom; pair with `<redline-choice>` so the user can pick the winner in place; highlight the recommended option and say why in one line.
- `table.md`: right-align numbers, one visual emphasis column max, sticky header for >20 rows (`position:sticky`), wrap the table in `overflow-x:auto`, truncate long cells with `title` attributes carrying the full value; sort by the column the decision needs.
- `code.md`: `<pre><code>` with minimal inline highlighting (no highlight.js — keep artifacts dependency-free beyond the design kit); diff blocks with `+`/`-` line prefixes and green/red left borders; always give each snippet a heading naming file and range; wrap long lines rather than horizontal-scrolling the page; pair a risky hunk with `<redline-approve>`.
- `plan.md`: lead with a decision summary box (what's being proposed, what approval means); sections for scope, approach, risks, out-of-scope; every open question gets a `<redline-choice>` or `<redline-ask>` inline at the point of context, not collected at the bottom; end with a single `<redline-approve key="plan">`.
- `input.md`: the queue discipline (local state → explicit queue button → Send in tile footer); when to use which element (choice = closed set, approve = verdict on a thing shown, rating = calibration, ask = open text, question = composite forms); one `key` per question so re-answers replace; make queued state visible; never auto-queue on selection change; keep prompts specific enough that the drained note is actionable without follow-up.

- [ ] **Step 4: Update `skills/show-in-commando/SKILL.md`**

In its feedback-note shape documentation, extend the note field list with: `response?: {question, answer, data?}` — present when the note came from an in-page redline component rather than an element annotation; prefer it over parsing `comment`.

- [ ] **Step 5: Commit**

```bash
git add skills/ scripts/install-show-in-commando-skill
git commit -m "docs(skill): redline components, daemon-hosted artifacts, playbooks"
```

---

### Task 10: Integration check

**Files:** none new.

- [ ] **Step 1: Full test suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: clean, all tests pass.

- [ ] **Step 2: Smoke the daemon routes**

From the worktree, with an isolated port (no tmux needed for this smoke — the daemon may complain about missing tmux; if `server/index.ts` refuses to start without tmux, skip this step; the orchestrator's live e2e covers it):

```bash
COMMANDO_PORT=4979 COMMANDO_TOKEN=$(openssl rand -hex 16) COMMANDO_TMUX_SOCKET_NAME=redline-smoke npx tsx server/index.ts &
sleep 3
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4979/redline/design/daisyui.css   # expect 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4979/redline/sdk.js               # expect 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4979/redline/design/mermaid/mermaid.esm.min.mjs  # expect 200
kill %1
```

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes from full-suite run" # only if changes exist
```

---

## Self-Review Notes

- Spec §1 (serving) → Tasks 5, 8; §2 (transport/note shape) → Tasks 1, 2, 3; §3 (components) → Task 6; §4 (client UX) → Task 7; §5 (skill/playbooks) → Task 9; §6 (testing) → per-task tests + Task 10 + orchestrator live e2e.
- The pill strip already renders independent of review mode (`ChromiumTileCard.tsx:455`), so spec §4's "accepted regardless of toggle" needs no extra UI work — verified against source.
- `Runtime.enable` is required for `Runtime.bindingCalled` delivery — included in Task 3.
- Mermaid must be served as a tree (its ESM entry imports sibling chunks) — handled via `serveTreeFile`.
- Artifact responses are served `no-store` so review-loop edits appear on plain reload; the skill's `?v=<n>` cache-bust remains harmless.
