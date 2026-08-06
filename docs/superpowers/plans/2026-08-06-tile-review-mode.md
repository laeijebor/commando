# Tile Review Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Element-anchored user feedback on chromium tiles — a review mode where the user annotates elements on the screencast, comments queue as pills, and agents receive selector-anchored notes via a long-poll REST endpoint.

**Architecture:** The client overlay resolves elements through a new `inspect` request/response pair on the existing `/ws/web-tiles/:id` websocket; the daemon answers with a single CDP `Runtime.evaluate` (transient — nothing injected into the page). Queued notes POST to a per-pane in-memory feedback store; agents drain it with `GET /api/web-panes/:id/feedback?wait=N` (hook-token auth). Draining is the ack: it triggers the `web_panes` broadcast which now carries per-pane feedback info.

**Tech Stack:** TypeScript, Node http (no framework), `ws`, React 18, vitest (`// @vitest-environment jsdom` for DOM tests), vite.

**Spec:** `docs/superpowers/specs/2026-08-06-tile-review-mode-design.md` (read it first).

## Global Constraints

- Work in the worktree `/Users/leoijebor/dev/commando-tile-review`, branch `tile-review`. All paths below are relative to that root.
- No new npm dependencies.
- Follow the codebase's validation rigor: every value crossing a trust boundary (websocket message, HTTP body, page-returned data) is validated to an exact shape, like `parseTileInputEvent` (`server/chromium-engine.ts:284`) and `WebPanesApi.openPane` do.
- Server files import shared code with explicit `.js` extension (`'../shared/protocol.js'`); client (`src/`) imports without extension (`'../shared/protocol'`).
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`); do not add yourself as co-author.
- Run single test files with `npx vitest run <file>`; full suite `npm test`; types `npm run typecheck`.
- Caps (single source of truth, defined where noted): queued notes per tile 50; notes per POST 20; comment ≤ 4096 chars; selector ≤ 1024; tag ≤ 32; text ≤ 512; snippet ≤ 2048; pageUrl ≤ 2048 (`MAX_WEB_PANE_URL_LENGTH`); poll wait ≤ 60s.

---

### Task 1: Shared inspect probe (`shared/tile-inspect.ts`)

The page-side probe function, its serialization into a CDP `Runtime.evaluate` expression, and server-side re-validation of what the page returns.

**Files:**
- Create: `shared/tile-inspect.ts`
- Test: `shared/tile-inspect.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; browser globals only inside the probe).
- Produces (used by Tasks 3, 4, 7, 8):
  - `type TileInspectGrade = 'hover' | 'click'`
  - `type TileInspectRect = { x: number; y: number; width: number; height: number }`
  - `type TileInspectSuccess = { ok: true; selector: string; tag: string; rect: TileInspectRect; text?: string; snippet?: string }`
  - `type TileInspectFailure = { ok: false; error: string }`
  - `type TileInspectResult = TileInspectSuccess | TileInspectFailure`
  - `function inspectPageAt(doc: Document, x: number, y: number, grade: TileInspectGrade): TileInspectResult`
  - `function inspectExpression(x: number, y: number, grade: TileInspectGrade): string`
  - `function parseTileInspectResult(value: unknown): TileInspectResult | null`

- [ ] **Step 1: Write the failing tests**

```ts
// shared/tile-inspect.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { inspectExpression, inspectPageAt, parseTileInspectResult } from './tile-inspect'

function mount(html: string): void {
  document.body.innerHTML = html
}

function atPoint(element: Element | null) {
  // jsdom has no layout, so hit-testing is mocked; we test selector building.
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(element)
}

describe('inspectPageAt', () => {
  it('reports failure when nothing is at the point', () => {
    atPoint(null)
    expect(inspectPageAt(document, 10, 10, 'hover')).toEqual({
      ok: false,
      error: 'No element at this point',
    })
  })

  it('prefers an id anchor and stops climbing there', () => {
    mount('<div id="root"><section><button>Go</button></section></div>')
    atPoint(document.querySelector('button'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('#root > section > button')
  })

  it('anchors on data-testid when there is no id', () => {
    mount('<div><ul data-testid="pr-list"><li></li><li class="hit"></li></ul></div>')
    atPoint(document.querySelector('li.hit'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('ul[data-testid="pr-list"] > li:nth-of-type(2)')
  })

  it('falls back to an nth-of-type path from body', () => {
    mount('<article></article><article><p></p><p class="hit"></p></article>')
    atPoint(document.querySelector('p.hit'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('body > article:nth-of-type(2) > p:nth-of-type(2)')
  })

  it('hover omits text and snippet; click includes both, truncated', () => {
    mount(`<div id="a"><span>${'x'.repeat(4000)}</span></div>`)
    atPoint(document.querySelector('span'))
    const hover = inspectPageAt(document, 1, 1, 'hover')
    if (hover.ok) {
      expect(hover.text).toBeUndefined()
      expect(hover.snippet).toBeUndefined()
    }
    const click = inspectPageAt(document, 1, 1, 'click')
    expect(click.ok).toBe(true)
    if (click.ok) {
      expect(click.text?.length).toBe(512)
      expect(click.snippet?.length).toBe(2048)
      expect(click.tag).toBe('span')
    }
  })

  it('escapes ids that are not plain identifiers', () => {
    mount('<div id="a:b"><i>x</i></div>')
    atPoint(document.querySelector('i'))
    const result = inspectPageAt(document, 1, 1, 'hover')
    if (result.ok) expect(document.querySelector(result.selector)).toBe(document.querySelector('i'))
  })
})

describe('inspectExpression', () => {
  it('stringifies to a self-contained expression that still works', () => {
    mount('<div id="root"><button>Go</button></div>')
    const target = document.querySelector('button')
    const doc = { elementFromPoint: () => target } as unknown as Document
    // Re-hydrate the stringified probe exactly as the page would evaluate it.
    const fn = (0, eval)(`(${inspectPageAt.toString()})`) as typeof inspectPageAt
    const result = fn(doc, 3, 4, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('#root > button')
    // And the expression embeds the arguments.
    expect(inspectExpression(3, 4, 'click')).toContain('(document, 3, 4, "click")')
  })
})

describe('parseTileInspectResult', () => {
  it('accepts a valid success and truncates oversized page-supplied strings', () => {
    const parsed = parseTileInspectResult({
      ok: true,
      selector: 's'.repeat(5000),
      tag: 'button',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 't'.repeat(5000),
      snippet: 'h'.repeat(5000),
    })
    expect(parsed?.ok).toBe(true)
    if (parsed?.ok) {
      expect(parsed.selector.length).toBe(1024)
      expect(parsed.text?.length).toBe(512)
      expect(parsed.snippet?.length).toBe(2048)
    }
  })

  it('accepts a failure shape', () => {
    expect(parseTileInspectResult({ ok: false, error: 'nope' })).toEqual({ ok: false, error: 'nope' })
  })

  it('rejects malformed values', () => {
    expect(parseTileInspectResult(null)).toBeNull()
    expect(parseTileInspectResult({ ok: true })).toBeNull()
    expect(parseTileInspectResult({ ok: true, selector: 'a', tag: 'b', rect: { x: 'no' } })).toBeNull()
    expect(parseTileInspectResult({ ok: false, error: 42 })).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/tile-inspect.test.ts`
Expected: FAIL — module `./tile-inspect` does not exist.

- [ ] **Step 3: Implement `shared/tile-inspect.ts`**

```ts
export type TileInspectGrade = 'hover' | 'click'
export type TileInspectRect = { x: number; y: number; width: number; height: number }
export type TileInspectSuccess = {
  ok: true
  selector: string
  tag: string
  rect: TileInspectRect
  text?: string
  snippet?: string
}
export type TileInspectFailure = { ok: false; error: string }
export type TileInspectResult = TileInspectSuccess | TileInspectFailure

export const MAX_INSPECT_SELECTOR = 1_024
export const MAX_INSPECT_TAG = 32
export const MAX_INSPECT_TEXT = 512
export const MAX_INSPECT_SNIPPET = 2_048

/**
 * The page-side probe. It is STRINGIFIED into a CDP Runtime.evaluate
 * expression, so it MUST stay self-contained: browser globals only, no
 * captured module constants or imports — the length caps are inlined
 * (mirrored by the exported MAX_INSPECT_* constants for the server side).
 */
export function inspectPageAt(
  doc: Document,
  x: number,
  y: number,
  grade: 'hover' | 'click',
): TileInspectResult {
  const target = doc.elementFromPoint(x, y)
  if (!target) return { ok: false, error: 'No element at this point' }
  const escapeCss = (value: string): string =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
  const nthStep = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    const parent = el.parentElement
    if (!parent) return tag
    const siblings = Array.prototype.filter.call(
      parent.children,
      (child: Element) => child.tagName === el.tagName,
    ) as Element[]
    return siblings.length === 1 ? tag : `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`
  }
  const parts: string[] = []
  let el: Element | null = target
  while (el && el.tagName.toLowerCase() !== 'html') {
    if (el.id) {
      parts.unshift(`#${escapeCss(el.id)}`)
      break
    }
    const testId = el.getAttribute('data-testid')
    if (testId) {
      parts.unshift(`${el.tagName.toLowerCase()}[data-testid="${escapeCss(testId)}"]`)
      break
    }
    parts.unshift(nthStep(el))
    el = el.parentElement
  }
  const rect = target.getBoundingClientRect()
  const result: TileInspectSuccess = {
    ok: true,
    selector: parts.join(' > ').slice(0, 1024),
    tag: target.tagName.toLowerCase().slice(0, 32),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
  if (grade === 'click') {
    const text = (target.textContent ?? '').trim()
    if (text) result.text = text.slice(0, 512)
    result.snippet = target.outerHTML.slice(0, 2048)
  }
  return result
}

/** Serializes the probe into a one-shot Runtime.evaluate expression. */
export function inspectExpression(x: number, y: number, grade: TileInspectGrade): string {
  return `(${inspectPageAt.toString()})(document, ${x}, ${y}, ${JSON.stringify(grade)})`
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Re-validates what the page returned. The evaluated value crosses a trust
 * boundary (the page controls it), so shapes are checked and strings
 * re-truncated server-side.
 */
export function parseTileInspectResult(value: unknown): TileInspectResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.ok === false) {
    return typeof record.error === 'string'
      ? { ok: false, error: record.error.slice(0, 256) }
      : null
  }
  if (record.ok !== true) return null
  const rect = record.rect as Record<string, unknown> | undefined
  if (
    typeof record.selector !== 'string' || record.selector.length === 0 ||
    typeof record.tag !== 'string' || record.tag.length === 0 ||
    typeof rect !== 'object' || rect === null ||
    !finiteNumber(rect.x) || !finiteNumber(rect.y) ||
    !finiteNumber(rect.width) || !finiteNumber(rect.height) ||
    (record.text !== undefined && typeof record.text !== 'string') ||
    (record.snippet !== undefined && typeof record.snippet !== 'string')
  ) {
    return null
  }
  return {
    ok: true,
    selector: record.selector.slice(0, MAX_INSPECT_SELECTOR),
    tag: record.tag.slice(0, MAX_INSPECT_TAG),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ...(record.text !== undefined ? { text: record.text.slice(0, MAX_INSPECT_TEXT) } : {}),
    ...(record.snippet !== undefined ? { snippet: record.snippet.slice(0, MAX_INSPECT_SNIPPET) } : {}),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/tile-inspect.test.ts`
Expected: PASS. If the `escapes ids` test fails on `document.querySelector(result.selector)`, check jsdom supports `CSS.escape` (it does; the fallback branch is for exotic pages).

- [ ] **Step 5: Commit**

```bash
git add shared/tile-inspect.ts shared/tile-inspect.test.ts
git commit -m "feat(shared): tile inspect probe with serializable selector builder"
```

---

### Task 2: Feedback protocol types + store (`server/web-pane-feedback.ts`)

**Files:**
- Modify: `shared/protocol.ts` (append near the `WebPane` types, around line 275)
- Create: `server/web-pane-feedback.ts`
- Test: `server/web-pane-feedback.test.ts`

**Interfaces:**
- Consumes: `WebPaneError` from `./web-panes.js`.
- Produces (used by Tasks 4–8):
  - In `shared/protocol.ts`:
    - `type WebPaneFeedbackNote = { selector: string; tag: string; text?: string; rect: { x: number; y: number; width: number; height: number }; comment: string; pageUrl: string; capturedAt: number }`
    - `type WebPaneFeedbackInfo = { queued: number; lastDrainCount?: number; lastDrainAt?: number }`
    - The `web_panes` member of `ServerMessage` becomes `{ type: 'web_panes'; webPanes: WebPane[]; feedback?: Record<string, WebPaneFeedbackInfo> }`
  - In `server/web-pane-feedback.ts`:
    - `const MAX_QUEUED_FEEDBACK_NOTES = 50`
    - `const MAX_FEEDBACK_WAIT_MS = 60_000`
    - `class WebPaneFeedbackStore`:
      - `constructor(onDrain: (webPaneId: string) => void = () => undefined, now: () => number = Date.now)`
      - `enqueue(webPaneId: string, notes: WebPaneFeedbackNote[]): void` — throws `WebPaneError(429, ...)` past the cap
      - `drain(webPaneId: string, waitMs: number, signal?: AbortSignal): Promise<WebPaneFeedbackNote[]>`
      - `retain(liveIds: ReadonlySet<string>): void`
      - `info(): Record<string, WebPaneFeedbackInfo>`

- [ ] **Step 1: Add the protocol types**

In `shared/protocol.ts`, after the `MAX_WEB_PANE_URL_LENGTH` constant (line 278), add:

```ts
export type WebPaneFeedbackNote = {
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  pageUrl: string
  capturedAt: number
}

/** Ephemeral review-feedback state for a tile — broadcast, never persisted. */
export type WebPaneFeedbackInfo = {
  queued: number
  lastDrainCount?: number
  lastDrainAt?: number
}
```

and change the `web_panes` member of `ServerMessage` (line 324) to:

```ts
  | { type: 'web_panes'; webPanes: WebPane[]; feedback?: Record<string, WebPaneFeedbackInfo> }
```

- [ ] **Step 2: Write the failing store tests**

```ts
// server/web-pane-feedback.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { MAX_QUEUED_FEEDBACK_NOTES, WebPaneFeedbackStore } from './web-pane-feedback.js'
import { WebPaneError } from './web-panes.js'

afterEach(() => {
  vi.useRealTimers()
})

function note(comment = 'too cramped'): WebPaneFeedbackNote {
  return {
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('WebPaneFeedbackStore', () => {
  it('drains queued notes immediately and records the drain', async () => {
    const onDrain = vi.fn()
    const store = new WebPaneFeedbackStore(onDrain, () => 42)
    store.enqueue('w-11111111', [note('a'), note('b')])
    const notes = await store.drain('w-11111111', 0)
    expect(notes.map((entry) => entry.comment)).toEqual(['a', 'b'])
    expect(onDrain).toHaveBeenCalledWith('w-11111111')
    expect(store.info()['w-11111111']).toEqual({ queued: 0, lastDrainCount: 2, lastDrainAt: 42 })
  })

  it('returns empty (and records nothing) when the wait times out', async () => {
    vi.useFakeTimers()
    const onDrain = vi.fn()
    const store = new WebPaneFeedbackStore(onDrain)
    const pending = store.drain('w-11111111', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual([])
    expect(onDrain).not.toHaveBeenCalled()
    expect(store.info()['w-11111111']).toBeUndefined()
  })

  it('wakes a waiting drain when notes arrive', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const pending = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await pending).length).toBe(1)
    expect(store.info()['w-11111111']?.queued).toBe(0)
  })

  it('hands a batch to only the first of two concurrent waiters', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const first = store.drain('w-11111111', 30_000)
    const second = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await first).length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await second).toEqual([])
  })

  it('throws 429 past the queue cap', () => {
    const store = new WebPaneFeedbackStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) store.enqueue('w-11111111', [note()])
    expect(() => store.enqueue('w-11111111', [note()])).toThrowError(WebPaneError)
    try {
      store.enqueue('w-11111111', [note()])
    } catch (error) {
      expect((error as WebPaneError).status).toBe(429)
    }
  })

  it('retain() discards dead panes and rejects their waiters with 404', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    store.enqueue('w-22222222', [note()])
    const waiting = store.drain('w-11111111', 30_000)
    store.retain(new Set(['w-33333333']))
    await expect(waiting).rejects.toMatchObject({ status: 404 })
    expect(store.info()).toEqual({})
  })

  it('an aborted drain resolves empty without recording a drain', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const controller = new AbortController()
    const pending = store.drain('w-11111111', 30_000, controller.signal)
    controller.abort()
    expect(await pending).toEqual([])
    store.enqueue('w-11111111', [note()])
    expect(store.info()['w-11111111']?.queued).toBe(1)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/web-pane-feedback.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the store**

```ts
// server/web-pane-feedback.ts
import type { WebPaneFeedbackInfo, WebPaneFeedbackNote } from '../shared/protocol.js'
import { WebPaneError } from './web-panes.js'

export const MAX_QUEUED_FEEDBACK_NOTES = 50
export const MAX_FEEDBACK_WAIT_MS = 60_000

type Waiter = {
  settle: (notes: WebPaneFeedbackNote[]) => void
  fail: (error: WebPaneError) => void
}

/**
 * In-memory per-tile review feedback: the tile UI enqueues notes, the agent
 * drains them over a long-poll. Draining is the ack — onDrain lets the daemon
 * broadcast the new state. Nothing here is persisted; feedback dies with the
 * tile (or the daemon), by design.
 */
export class WebPaneFeedbackStore {
  private readonly queues = new Map<string, WebPaneFeedbackNote[]>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly drains = new Map<string, { count: number; at: number }>()

  constructor(
    private readonly onDrain: (webPaneId: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(webPaneId: string, notes: WebPaneFeedbackNote[]): void {
    if (notes.length === 0) return
    const waiting = this.waiters.get(webPaneId)
    if (waiting && waiting.length > 0) {
      const queued = this.queues.get(webPaneId) ?? []
      this.queues.delete(webPaneId)
      const batch = [...queued, ...notes]
      waiting.shift()?.settle(this.recordDrain(webPaneId, batch))
      return
    }
    const queue = this.queues.get(webPaneId) ?? []
    if (queue.length + notes.length > MAX_QUEUED_FEEDBACK_NOTES) {
      throw new WebPaneError(429, `At most ${MAX_QUEUED_FEEDBACK_NOTES} notes can be queued per tile`)
    }
    this.queues.set(webPaneId, [...queue, ...notes])
  }

  drain(webPaneId: string, waitMs: number, signal?: AbortSignal): Promise<WebPaneFeedbackNote[]> {
    const queued = this.queues.get(webPaneId)
    if (queued && queued.length > 0) {
      this.queues.delete(webPaneId)
      return Promise.resolve(this.recordDrain(webPaneId, queued))
    }
    const wait = Math.max(0, Math.min(waitMs, MAX_FEEDBACK_WAIT_MS))
    if (wait === 0 || signal?.aborted) return Promise.resolve([])
    return new Promise<WebPaneFeedbackNote[]>((resolve, reject) => {
      const waiter: Waiter = {
        settle: (notes) => {
          cleanup()
          resolve(notes)
        },
        fail: (error) => {
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => waiter.settle([]), wait)
      const onAbort = (): void => waiter.settle([])
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const list = this.waiters.get(webPaneId)
        if (list) {
          const index = list.indexOf(waiter)
          if (index >= 0) list.splice(index, 1)
          if (list.length === 0) this.waiters.delete(webPaneId)
        }
      }
      signal?.addEventListener('abort', onAbort)
      const list = this.waiters.get(webPaneId) ?? []
      list.push(waiter)
      this.waiters.set(webPaneId, list)
    })
  }

  /** Discards feedback state for panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const map of [this.queues, this.drains] as const) {
      for (const id of [...map.keys()]) {
        if (!liveIds.has(id)) map.delete(id)
      }
    }
    for (const [id, list] of [...this.waiters]) {
      if (liveIds.has(id)) continue
      this.waiters.delete(id)
      for (const waiter of list) waiter.fail(new WebPaneError(404, 'Web pane does not exist'))
    }
  }

  info(): Record<string, WebPaneFeedbackInfo> {
    const result: Record<string, WebPaneFeedbackInfo> = {}
    for (const [id, queue] of this.queues) {
      if (queue.length > 0) result[id] = { queued: queue.length }
    }
    for (const [id, drain] of this.drains) {
      result[id] = {
        queued: result[id]?.queued ?? 0,
        lastDrainCount: drain.count,
        lastDrainAt: drain.at,
      }
    }
    return result
  }

  private recordDrain(webPaneId: string, notes: WebPaneFeedbackNote[]): WebPaneFeedbackNote[] {
    this.drains.set(webPaneId, { count: notes.length, at: this.now() })
    this.onDrain(webPaneId)
    return notes
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/web-pane-feedback.test.ts` — expected PASS.
Run: `npm run typecheck` — expected clean (protocol change is additive).

- [ ] **Step 6: Commit**

```bash
git add shared/protocol.ts server/web-pane-feedback.ts server/web-pane-feedback.test.ts
git commit -m "feat(server): per-tile review feedback store with long-poll drain"
```

---

### Task 3: Engine `inspectAt` + `parseTileInspectRequest` (`server/chromium-engine.ts`)

**Files:**
- Modify: `server/chromium-engine.ts` (add near `parseTileInputEvent`, line 284, and as a method on `ChromiumEngine` near `dispatchInput`, line 456)
- Test: `server/chromium-engine.test.ts` (extend)

**Interfaces:**
- Consumes: `inspectExpression`, `parseTileInspectResult`, `TileInspectGrade`, `TileInspectResult` from `../shared/tile-inspect.js`.
- Produces (used by Task 4):
  - `type TileInspectRequest = { id: string; x: number; y: number; grade: TileInspectGrade }`
  - `function parseTileInspectRequest(value: unknown): TileInspectRequest | null` — validates `{type:'inspect', id, x, y, grade}` messages; `id` is a string ≤ 64 chars; `x`/`y` in `[0, MAX_VIEWPORT_DIMENSION]`
  - `ChromiumEngine.inspectAt(webPaneId: string, x: number, y: number, grade: TileInspectGrade): Promise<TileInspectResult>` — never rejects for page-level problems; returns `{ok:false,error}` instead. Only missing-tile is also `{ok:false}` (no live target).

Read `CdpConnection` (top of the file, ~lines 100–245) before implementing: `send(method, params)` resolves with the CDP `result` payload and rejects on protocol errors — so `Runtime.evaluate` resolves to `{ result: RemoteObject, exceptionDetails? }`.

- [ ] **Step 1: Write the failing tests**

In `server/chromium-engine.test.ts`, study the existing `StubChromium` harness (it acks every CDP call). Add a canned-response hook so a test can answer `Runtime.evaluate`: give `StubChromium` a public field like `evaluateValue: unknown = null` and, in its per-target websocket message handler where calls are acked, when `method === 'Runtime.evaluate'` reply with `{ id, result: { result: { type: 'object', value: this.evaluateValue } } }` instead of the generic ack. Then add:

```ts
describe('parseTileInspectRequest', () => {
  it('accepts a valid inspect request', () => {
    expect(
      parseTileInspectRequest({ type: 'inspect', id: 'i-1', x: 10.5, y: 20, grade: 'hover' }),
    ).toEqual({ id: 'i-1', x: 10.5, y: 20, grade: 'hover' })
  })

  it('rejects bad grades, coordinates, and ids', () => {
    expect(parseTileInspectRequest({ type: 'inspect', id: 'i', x: 1, y: 1, grade: 'poke' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', id: 'i', x: -1, y: 1, grade: 'hover' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', id: 'x'.repeat(65), x: 1, y: 1, grade: 'hover' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', x: 1, y: 1, grade: 'hover' })).toBeNull()
  })
})

describe('ChromiumEngine.inspectAt', () => {
  it('evaluates the probe and returns the validated result', async () => {
    // Follow the existing engine tests' setup pattern (StubChromium + engine
    // with a launcher pointing at the stub). Subscribe a screencast first so
    // the target exists, as neighboring tests do.
    stub.evaluateValue = {
      ok: true,
      selector: '#root > button',
      tag: 'button',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    }
    const result = await engine.inspectAt('w-11111111', 10, 20, 'hover')
    expect(result).toEqual(stub.evaluateValue)
    const call = stub.calls.find((entry) => entry.method === 'Runtime.evaluate')
    expect(call?.params?.returnByValue).toBe(true)
    expect(String(call?.params?.expression)).toContain('(document, 10, 20, "hover")')
  })

  it('reports a friendly failure for a tile with no live target', async () => {
    const result = await engine.inspectAt('w-99999999', 1, 1, 'hover')
    expect(result).toEqual({ ok: false, error: 'Tile has no live chromium target' })
  })

  it('reports a failure when the page returns garbage', async () => {
    stub.evaluateValue = { ok: true, selector: 42 }
    const result = await engine.inspectAt('w-11111111', 1, 1, 'hover')
    expect(result.ok).toBe(false)
  })
})
```

(Adapt variable names to the file's existing test setup — it constructs engines per-test; reuse its helpers rather than inventing new scaffolding.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/chromium-engine.test.ts`
Expected: new tests FAIL (`parseTileInspectRequest`/`inspectAt` not defined); existing tests still PASS.

- [ ] **Step 3: Implement**

Import at the top of `server/chromium-engine.ts`:

```ts
import {
  inspectExpression,
  parseTileInspectResult,
  type TileInspectGrade,
  type TileInspectResult,
} from '../shared/tile-inspect.js'
```

After `parseTileInputEvent` add:

```ts
export type TileInspectRequest = { id: string; x: number; y: number; grade: TileInspectGrade }

/** Validates a client-supplied inspect request down to the exact forwarded shape. */
export function parseTileInspectRequest(value: unknown): TileInspectRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64 ||
    !finiteInRange(record.x, 0, MAX_VIEWPORT_DIMENSION) ||
    !finiteInRange(record.y, 0, MAX_VIEWPORT_DIMENSION) ||
    (record.grade !== 'hover' && record.grade !== 'click')
  ) {
    return null
  }
  return { id: record.id, x: record.x, y: record.y, grade: record.grade }
}
```

On `ChromiumEngine`, after `dispatchInput`:

```ts
  /**
   * Resolves the element under a viewport point with one transient
   * Runtime.evaluate — nothing is installed in the page. Page-level failures
   * come back as { ok: false } so the relay can answer the client either way.
   */
  async inspectAt(
    webPaneId: string,
    x: number,
    y: number,
    grade: TileInspectGrade,
  ): Promise<TileInspectResult> {
    const tile = this.tiles.get(webPaneId)
    if (!tile) return { ok: false, error: 'Tile has no live chromium target' }
    let evaluated: { result?: { value?: unknown }; exceptionDetails?: unknown }
    try {
      evaluated = (await tile.cdp.send('Runtime.evaluate', {
        expression: inspectExpression(x, y, grade),
        returnByValue: true,
      })) as typeof evaluated
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Inspect failed' }
    }
    if (evaluated.exceptionDetails) return { ok: false, error: 'Page threw while inspecting' }
    return (
      parseTileInspectResult(evaluated.result?.value) ??
      { ok: false, error: 'Page returned an invalid inspect result' }
    )
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/chromium-engine.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add server/chromium-engine.ts server/chromium-engine.test.ts
git commit -m "feat(server): resolve tile elements over CDP with a transient inspect probe"
```

---

### Task 4: Relay inspect routing (`server/web-tile-relay.ts`)

**Files:**
- Modify: `server/web-tile-relay.ts` (the `receive` method, line 126, and its call site at line 121)
- Create: `server/web-tile-relay.test.ts`

**Interfaces:**
- Consumes: `parseTileInspectRequest` from `./chromium-engine.js`, `engine.inspectAt`.
- Produces (used by Task 8's client): websocket reply `{ type: 'inspect_result', id: string, ...TileInspectResult }` — i.e. `{type, id, ok: true, selector, tag, rect, text?, snippet?}` or `{type, id, ok: false, error}`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/web-tile-relay.test.ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol.js'
import type { ChromiumEngine } from './chromium-engine.js'
import type { WebPaneService } from './web-panes.js'
import { WebTileRelay, webTilePathId } from './web-tile-relay.js'

const servers: Server[] = []
const relays: WebTileRelay[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const relay of relays.splice(0)) relay.close()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function pane(): WebPane {
  return {
    id: 'w-11111111',
    url: 'http://127.0.0.1:5173/',
    sessionId: '$1',
    windowId: '@2',
    anchorPaneId: '%12',
    placement: 'right',
    engine: 'chromium',
    openedBy: 'agent',
    status: 'open',
    createdAt: 0,
  }
}

async function startRelay(engineOverrides: Partial<ChromiumEngine> = {}) {
  const engine = {
    subscribeScreencast: vi.fn(async () => () => undefined),
    dispatchInput: vi.fn(),
    setViewport: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspectAt: vi.fn(async () => ({ ok: true as const, selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 } })),
    ...engineOverrides,
  } as unknown as ChromiumEngine
  const service = { get: (id: string) => (id === 'w-11111111' ? pane() : undefined) } as unknown as WebPaneService
  const relay = new WebTileRelay({ engine, service })
  relays.push(relay)
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const id = webTilePathId(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (id) relay.handleUpgrade(request, socket, head, id)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/web-tiles/w-11111111`)
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.once('open', () => resolve()))
  return { socket, engine }
}

function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: unknown): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      if (message.type !== type) return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

describe('web tile relay inspect routing', () => {
  it('answers a valid inspect with an inspect_result carrying the same id', async () => {
    const { socket, engine } = await startRelay()
    const reply = nextMessage(socket, 'inspect_result')
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-7', x: 10, y: 20, grade: 'hover' }))
    expect(await reply).toMatchObject({ id: 'i-7', ok: true, selector: '#a' })
    expect(engine.inspectAt).toHaveBeenCalledWith('w-11111111', 10, 20, 'hover')
  })

  it('ignores malformed inspect requests', async () => {
    const { socket, engine } = await startRelay()
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-7', x: -5, y: 20, grade: 'hover' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(engine.inspectAt).not.toHaveBeenCalled()
  })

  it('turns an inspectAt rejection into an ok:false reply', async () => {
    const { socket } = await startRelay({
      inspectAt: vi.fn(async () => {
        throw new Error('cdp went away')
      }),
    } as unknown as Partial<ChromiumEngine>)
    const reply = nextMessage(socket, 'inspect_result')
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-8', x: 1, y: 1, grade: 'click' }))
    expect(await reply).toMatchObject({ id: 'i-8', ok: false })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/web-tile-relay.test.ts`
Expected: FAIL — inspect messages are silently dropped (no `inspect_result` ever arrives; the first test times out).

- [ ] **Step 3: Implement**

In `server/web-tile-relay.ts`: import `parseTileInspectRequest` from `./chromium-engine.js`; change the message hookup at line 121 to pass the socket:

```ts
    socket.on('message', (data: RawData) => this.receive(socket, webPaneId, data))
```

change `receive`'s signature to `private receive(socket: WebSocket, webPaneId: string, data: RawData): void` and add, after the `reload` branch:

```ts
    if (message.type === 'inspect') {
      const request = parseTileInspectRequest(message)
      if (!request) return
      void this.dependencies.engine
        .inspectAt(webPaneId, request.x, request.y, request.grade)
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'Inspect failed',
        }))
        .then((result) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify({ type: 'inspect_result', id: request.id, ...result }))
        })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/web-tile-relay.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add server/web-tile-relay.ts server/web-tile-relay.test.ts
git commit -m "feat(server): route tile inspect requests through the web-tile relay"
```

---

### Task 5: Feedback REST routes (`server/web-panes-api.ts`)

**Files:**
- Modify: `server/web-panes-api.ts`
- Test: `server/web-panes-api.test.ts` (extend)

**Interfaces:**
- Consumes: `WebPaneFeedbackStore` (Task 2), `MAX_WEB_PANE_URL_LENGTH` + `WebPaneFeedbackNote` from `../shared/protocol.js`, `MAX_INSPECT_SELECTOR`/`MAX_INSPECT_TAG`/`MAX_INSPECT_TEXT` from `../shared/tile-inspect.js`.
- Produces (used by Tasks 6, 8, 9):
  - New required dependency on `WebPanesApiDependencies`: `feedback: WebPaneFeedbackStore`.
  - `POST /api/web-panes/:id/feedback` — **owner-only** (agents get 403 `'Only the owner can submit feedback'`). Body `{notes: WebPaneFeedbackNote[]}`, 1–20 notes, each validated (shape below). 404 if the pane does not exist. Replies `{ok: true, webPaneId, queued: <number now queued>}` — where `queued` is read back from `store.info()` after the enqueue (0 when a waiting agent consumed the batch instantly).
  - `GET /api/web-panes/:id/feedback?wait=N` — **agent-only** (owner gets 403 `'Only agents poll feedback'` — draining is the ack, and an owner drain would fake it). `wait` is seconds 0–60 (default 0; invalid values → 400). 404 if the pane does not exist. Long-polls via `store.drain(id, wait * 1000, signal)` with an `AbortController` aborted on the request's `close` event. Replies `{ok: true, webPaneId, notes}`.
  - Note validation: `selector` string 1–1024; `tag` string 1–32; `text` optional string ≤ 512; `comment` string 1–4096; `pageUrl` string ≤ `MAX_WEB_PANE_URL_LENGTH`; `rect` object with finite `x`/`y`/`width`/`height`; `capturedAt` finite number ≥ 0. Any violation → 400.

- [ ] **Step 1: Write the failing tests**

Extend `server/web-panes-api.test.ts`. The existing `startApi` helper takes `Overrides`; add a `WebPaneFeedbackStore` to the default dependencies (`feedback: new WebPaneFeedbackStore(() => onChange())` — construct it inside `startApi` so tests can also pass their own) and return it from the helper. Then add a `describe('feedback routes', ...)` with:

```ts
async function openChromiumPane(service: WebPaneService): Promise<string> {
  return service.open({
    url: 'http://127.0.0.1:5173/',
    anchorPaneId: '%12',
    sessionId: '$1',
    windowId: '@3',
    engine: 'chromium',
    openedBy: 'agent',
  }).id
}

function feedbackNote(comment = 'make this button larger') {
  return {
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('feedback routes', () => {
  it('owner submits, agent drains, and onChange fires on the drain', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service)
    const id = await openChromiumPane(service)
    const posted = await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)
    expect(posted.status).toBe(200)
    onChange.mockClear()
    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(drained.status).toBe(200)
    const body = await drained.json() as { notes: unknown[] }
    expect(body.notes).toHaveLength(1)
    expect(onChange).toHaveBeenCalled()
    const again = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(((await again.json()) as { notes: unknown[] }).notes).toHaveLength(0)
  })

  it('long-poll wakes when the owner submits mid-wait', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const pending = fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=10`, { headers: agentAuth })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)
    const body = await (await pending).json() as { notes: unknown[] }
    expect(body.notes).toHaveLength(1)
  })

  it('rejects agents submitting and owners draining', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const submit = await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, agentAuth)
    expect(submit.status).toBe(403)
    const drain = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: { 'x-test-owner': 'yes' } })
    expect(drain.status).toBe(403)
  })

  it('rejects malformed notes, unknown panes, and bad wait values', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [{ comment: 'no selector' }] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [{ ...feedbackNote(), comment: 'x'.repeat(5000) }] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, '/api/web-panes/w-00000000/feedback', { notes: [feedbackNote()] }, ownerAuth)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=999`, { headers: agentAuth })).status).toBe(400)
  })

  it('returns 429 once the tile queue is full', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    for (let i = 0; i < 5; i += 1) {
      const batch = Array.from({ length: 10 }, () => feedbackNote(`note ${i}`))
      expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: batch }, ownerAuth)).status).toBe(200)
    }
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)).status).toBe(429)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/web-panes-api.test.ts`
Expected: new tests FAIL with 404s (route doesn't exist); existing tests PASS (after wiring the new `feedback` constructor dependency into `startApi` — the constructor addition will make TypeScript force this).

- [ ] **Step 3: Implement**

In `server/web-panes-api.ts`:
1. Imports: `WebPaneFeedbackStore`, `MAX_FEEDBACK_WAIT_MS` from `./web-pane-feedback.js`; `MAX_WEB_PANE_URL_LENGTH`, `type WebPaneFeedbackNote` from `../shared/protocol.js`; `MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT` from `../shared/tile-inspect.js`. Add `feedback: WebPaneFeedbackStore` to `WebPanesApiDependencies`.
2. Extend the route regex (line 232) to `/^\/api\/web-panes\/([^/]+)(?:\/(confirm|cdp|feedback))?$/` and the action union to `'confirm' | 'cdp' | 'feedback' | 'delete'`.
3. Add the `feedback` branch in `handle` before the DELETE fallthrough:

```ts
      if (route.action === 'feedback') {
        if (!this.dependencies.service.get(route.id)) {
          throw new HttpError(404, 'Web pane does not exist')
        }
        if (request.method === 'POST') {
          if (caller !== 'owner') {
            throw new HttpError(403, 'Only the owner can submit feedback')
          }
          const notes = parseFeedbackNotes(await readJson(request))
          this.dependencies.feedback.enqueue(route.id, notes)
          this.dependencies.onChange()
          const queued = this.dependencies.feedback.info()[route.id]?.queued ?? 0
          writeJson(response, 200, { ok: true, webPaneId: route.id, queued })
          return true
        }
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        if (caller !== 'agent') throw new HttpError(403, 'Only agents poll feedback')
        const waitRaw = url.searchParams.get('wait') ?? '0'
        const wait = Number(waitRaw)
        if (!Number.isFinite(wait) || wait < 0 || wait > MAX_FEEDBACK_WAIT_MS / 1_000) {
          throw new HttpError(400, 'wait must be between 0 and 60 seconds')
        }
        const controller = new AbortController()
        const onClose = (): void => controller.abort()
        request.on('close', onClose)
        try {
          const notes = await this.dependencies.feedback.drain(route.id, wait * 1_000, controller.signal)
          writeJson(response, 200, { ok: true, webPaneId: route.id, notes })
        } finally {
          request.off('close', onClose)
        }
        return true
      }
```

4. Module-level validator (near `readJson`), returning validated notes or throwing 400:

```ts
const MAX_FEEDBACK_NOTES_PER_POST = 20
const MAX_FEEDBACK_COMMENT = 4_096

function parseFeedbackNotes(body: Record<string, unknown>): WebPaneFeedbackNote[] {
  const raw = body.notes
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FEEDBACK_NOTES_PER_POST) {
    throw new HttpError(400, `notes must contain 1 to ${MAX_FEEDBACK_NOTES_PER_POST} entries`)
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new HttpError(400, 'Each note must be an object')
    const note = entry as Record<string, unknown>
    const rect = note.rect as Record<string, unknown> | undefined
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    if (
      typeof note.selector !== 'string' || note.selector.length === 0 || note.selector.length > MAX_INSPECT_SELECTOR ||
      typeof note.tag !== 'string' || note.tag.length === 0 || note.tag.length > MAX_INSPECT_TAG ||
      (note.text !== undefined && (typeof note.text !== 'string' || note.text.length > MAX_INSPECT_TEXT)) ||
      typeof note.comment !== 'string' || note.comment.length === 0 || note.comment.length > MAX_FEEDBACK_COMMENT ||
      typeof note.pageUrl !== 'string' || note.pageUrl.length > MAX_WEB_PANE_URL_LENGTH ||
      typeof rect !== 'object' || rect === null ||
      !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height) ||
      !finite(note.capturedAt) || note.capturedAt < 0
    ) {
      throw new HttpError(400, 'Note is malformed')
    }
    return {
      selector: note.selector,
      tag: note.tag,
      ...(note.text !== undefined ? { text: note.text } : {}),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      comment: note.comment,
      pageUrl: note.pageUrl,
      capturedAt: note.capturedAt,
    }
  })
}
```

5. Update the 405 `Allow` header logic (line 202) so `/feedback` paths advertise `GET, POST`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/web-panes-api.test.ts` — expected PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add server/web-panes-api.ts server/web-panes-api.test.ts
git commit -m "feat(server): owner-submit / agent-drain feedback routes on web panes"
```

---

### Task 6: Daemon wiring (`server/index.ts`)

**Files:**
- Modify: `server/index.ts` (around lines 437–453, 1158–1196, 1509)

**Interfaces:**
- Consumes: `WebPaneFeedbackStore` (Task 2); the extended `web_panes` message (Task 2); `WebPanesApi`'s new `feedback` dependency (Task 5).
- Produces: running daemon behavior — every `web_panes` broadcast carries `feedback`, dead panes' feedback is discarded (waiters get 404), drains re-broadcast.

- [ ] **Step 1: Wire the store**

In `server/index.ts`:
1. Import `WebPaneFeedbackStore` from `./web-pane-feedback.js`.
2. After the `webTileRelay` construction (line 437), create the store. It references `publishWebPanes` before that const is declared — fine at runtime (the callback fires long after startup), but keep the declaration adjacent and note it:

```ts
  // onDrain fires only at request time, safely after publishWebPanes exists.
  const webPaneFeedback = new WebPaneFeedbackStore(() => publishWebPanes())
```

3. Extend `publishWebPanes` (line 443): after `webTileRelay.dropStale(streamable)` add

```ts
    webPaneFeedback.retain(new Set(webPanes.list().map((pane) => pane.id)))
```

and change the broadcast to

```ts
    broadcast({ type: 'web_panes', webPanes: webPanes.list(), feedback: webPaneFeedback.info() })
```

4. Add `feedback: webPaneFeedback` to the `WebPanesApi` constructor call (line 1158).
5. Update the initial per-client send (line 1509) to include `feedback: webPaneFeedback.info()`.

- [ ] **Step 2: Verify**

Run: `npm run typecheck` — expected clean.
Run: `npm test` — expected all green (this task has no new unit test of its own; the API tests cover the store integration, and the wiring is typechecked).

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): broadcast tile feedback state and retire it with dead panes"
```

---

### Task 7: Client review logic module (`src/tileReview.ts`)

Pure, React-free logic so the fiddly parts are unit-testable: the note queue and the hover-inspect throttle.

**Files:**
- Create: `src/tileReview.ts`
- Test: `src/tileReview.test.ts`

**Interfaces:**
- Consumes: `TileInspectSuccess` from `../shared/tile-inspect`; `WebPaneFeedbackNote` from `../shared/protocol`.
- Produces (used by Task 8):
  - `type QueuedReviewNote = { id: number; selector: string; tag: string; text?: string; rect: { x: number; y: number; width: number; height: number }; comment: string }`
  - `function queueNote(list: QueuedReviewNote[], inspect: TileInspectSuccess, comment: string, id: number): QueuedReviewNote[]`
  - `function removeNote(list: QueuedReviewNote[], id: number): QueuedReviewNote[]`
  - `function toFeedbackNotes(list: QueuedReviewNote[], pageUrl: string, now: number): WebPaneFeedbackNote[]`
  - `function createInspectThrottle(send: (x: number, y: number) => void, minIntervalMs = 50): { schedule: (x: number, y: number) => void; dispose: () => void }` — leading call fires immediately; calls inside the interval collapse to one trailing call with the latest coordinates.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tileReview.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInspectThrottle, queueNote, removeNote, toFeedbackNotes } from './tileReview'

afterEach(() => {
  vi.useRealTimers()
})

const inspect = {
  ok: true as const,
  selector: '#root > button',
  tag: 'button',
  rect: { x: 1, y: 2, width: 30, height: 10 },
  text: 'Go',
}

describe('review note queue', () => {
  it('queues, removes, and converts to feedback notes', () => {
    let list = queueNote([], inspect, 'too small', 1)
    list = queueNote(list, { ...inspect, selector: '#other' }, 'wrong color', 2)
    expect(list).toHaveLength(2)
    list = removeNote(list, 1)
    expect(list).toEqual([expect.objectContaining({ id: 2, selector: '#other' })])
    expect(toFeedbackNotes(list, 'http://127.0.0.1:5173/', 999)).toEqual([
      {
        selector: '#other',
        tag: 'button',
        text: 'Go',
        rect: { x: 1, y: 2, width: 30, height: 10 },
        comment: 'wrong color',
        pageUrl: 'http://127.0.0.1:5173/',
        capturedAt: 999,
      },
    ])
  })
})

describe('createInspectThrottle', () => {
  it('fires immediately, then collapses to a trailing latest-wins call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.schedule(3, 3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(1, 1)
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(3, 3)
  })

  it('dispose cancels the trailing call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.dispose()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tileReview.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement `src/tileReview.ts`**

```ts
import type { WebPaneFeedbackNote } from '../shared/protocol'
import type { TileInspectSuccess } from '../shared/tile-inspect'

export type QueuedReviewNote = {
  id: number
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
}

export function queueNote(
  list: QueuedReviewNote[],
  inspect: TileInspectSuccess,
  comment: string,
  id: number,
): QueuedReviewNote[] {
  return [
    ...list,
    {
      id,
      selector: inspect.selector,
      tag: inspect.tag,
      ...(inspect.text !== undefined ? { text: inspect.text } : {}),
      rect: inspect.rect,
      comment,
    },
  ]
}

export function removeNote(list: QueuedReviewNote[], id: number): QueuedReviewNote[] {
  return list.filter((note) => note.id !== id)
}

export function toFeedbackNotes(
  list: QueuedReviewNote[],
  pageUrl: string,
  now: number,
): WebPaneFeedbackNote[] {
  return list.map(({ id: _id, ...note }) => ({ ...note, pageUrl, capturedAt: now }))
}

/**
 * Leading-plus-trailing throttle for hover inspects: the first call goes out
 * immediately, calls during the interval collapse to one trailing call with
 * the latest coordinates.
 */
export function createInspectThrottle(
  send: (x: number, y: number) => void,
  minIntervalMs = 50,
): { schedule: (x: number, y: number) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { x: number; y: number } | null = null
  const flush = (): void => {
    timer = undefined
    if (!pending) return
    const { x, y } = pending
    pending = null
    send(x, y)
    timer = setTimeout(flush, minIntervalMs)
  }
  return {
    schedule: (x, y) => {
      if (timer) {
        pending = { x, y }
        return
      }
      send(x, y)
      timer = setTimeout(flush, minIntervalMs)
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = null
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tileReview.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tileReview.ts src/tileReview.test.ts
git commit -m "feat(web): review note queue and hover-inspect throttle"
```

---

### Task 8: Client UI — review mode on the tile

**Files:**
- Modify: `src/webPanesApi.ts` (add `submitFeedback`)
- Modify: `src/ChromiumTileCard.tsx` (review overlay, inspect wiring)
- Modify: `src/WebPaneCard.tsx` (toggle button, ack line, prop threading)
- Modify: `src/App.tsx` (`web_panes` handler ~line 1051, `WebPaneCard` usage ~line 2345)
- Modify: `src/web-pane.css` (review styles)
- Test: extend `src/webPanesApi.test.ts` if present, else add the fetch test inline in a new `describe` in `src/tileReview.test.ts`'s sibling `src/webPanesApi.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 7; existing `wsToken` socket flow in `ChromiumTileCard`.
- Produces (user-visible feature):
  - `WebPanesApiClient.submitFeedback(webPaneId: string, notes: WebPaneFeedbackNote[]): Promise<void>` — POST to `/api/web-panes/:id/feedback`.
  - `WebPaneCard` props gain `feedback?: WebPaneFeedbackInfo` and `onSubmitFeedback?: (notes: WebPaneFeedbackNote[]) => Promise<void>`.
  - `ChromiumTileCard` props gain `reviewMode: boolean`, `onSubmitFeedback: (notes: WebPaneFeedbackNote[]) => Promise<void>`.

Behavior contract for `ChromiumTileCard` in review mode:
- Wheel events still forward to the page (scrolling works); mouse down/up/move are **not** forwarded; keydown/keyup are **not** captured (typing goes to the comment card's textarea).
- `onMouseMove` calls `throttle.schedule(offsetX, offsetY)`; the throttle's `send` emits `{type:'inspect', id: 'h-'+n, x, y, grade:'hover'}` on the socket. Only the **latest** hover id's `inspect_result` updates the highlight (track `lastHoverId` in a ref; ignore stale/failed hovers by clearing the highlight).
- `onMouseDown` (left button) emits `{type:'inspect', id: 'c-'+n, x, y, grade:'click'}`; on its `inspect_result` with `ok:true`, open the comment card anchored near `result.rect` (clamp within the container); `ok:false` shows a transient "couldn't resolve an element here" hint (reuse the highlight box area, auto-clear after ~2s).
- Comment card: textarea + "Queue note" (disabled while empty) + "Cancel". Queue appends via `queueNote` (ids from an incrementing ref).
- Pill strip (bottom of tile): one pill per queued note showing `tag` + truncated comment, an `×` per pill (`removeNote`), and a "Send N notes" button that calls `onSubmitFeedback(toFeedbackNotes(queued, webPane.url, Date.now()))`, clears on success, shows the error message inline on failure (keep the queue).
- Leaving review mode clears highlight and open card but keeps queued pills.
- While the stream state is not `'streaming'`, review interactions are inert (the existing status overlay already covers the canvas); the WebPaneCard toggle stays clickable — no stream-state prop threading needed.

Behavior contract for `WebPaneCard`:
- Toggle button in the header for `chromium && !pending` tiles: lucide `MessageSquarePlus` icon, `aria-pressed={review}`, title "Review this page". State `const [review, setReview] = useState(false)`.
- Footer: when `feedback?.lastDrainCount` is set, append ` · agent received ${lastDrainCount} note${s} at ${new Date(lastDrainAt).toLocaleTimeString()}`.

`App.tsx` threading:
- New state `const [webPaneFeedback, setWebPaneFeedback] = useState<Record<string, WebPaneFeedbackInfo>>({})`; in the `web_panes` case also `setWebPaneFeedback(message.feedback ?? {})`.
- Pass to each `WebPaneCard`: `feedback={webPaneFeedback[webPane.id]}` and `onSubmitFeedback={(notes) => webPanesApi.submitFeedback(webPane.id, notes)}`.

- [ ] **Step 1: Write the failing `submitFeedback` test**

Create (or extend) `src/webPanesApi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createWebPanesApi } from './webPanesApi'

describe('submitFeedback', () => {
  it('POSTs notes to the feedback route', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    const note = {
      selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 },
      comment: 'c', pageUrl: 'http://127.0.0.1:5173/', capturedAt: 1,
    }
    await api.submitFeedback('w-11111111', [note])
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/web-panes/w-11111111/feedback')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ notes: [note] })
  })

  it('surfaces the server error message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'queue full' }), { status: 429 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    await expect(api.submitFeedback('w-11111111', [])).rejects.toThrowError('queue full')
  })
})
```

Run: `npx vitest run src/webPanesApi.test.ts` — expected FAIL (`submitFeedback` missing).

- [ ] **Step 2: Implement `submitFeedback`**

In `src/webPanesApi.ts`, add to the interface and the returned object:

```ts
    submitFeedback: async (webPaneId, notes) => {
      await request(`/${encodeURIComponent(webPaneId)}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      })
    },
```

with the interface member `submitFeedback(webPaneId: string, notes: WebPaneFeedbackNote[]): Promise<void>` (import the type from `../shared/protocol`). Run the test — expected PASS.

- [ ] **Step 3: Implement the tile UI**

Apply the behavior contracts above. Concrete structure for `ChromiumTileCard`:
- Keep all review state local: `highlight: {rect} | null`, `card: {inspect: TileInspectSuccess; x: number; y: number} | null`, `comment: string`, `queued: QueuedReviewNote[]`, `sendState: 'idle' | 'sending' | {error: string}`.
- Extend the socket `message` handler: `if (message.type === 'inspect_result') { route by id prefix ('h-' → highlight if id === lastHoverId.current, 'c-' → comment card or failure hint) }`.
- The inspect throttle: create in a `useEffect` tied to `reviewMode` (dispose on exit); `send` closes over `socketRef`.
- Overlay markup inside the `.chromium-tile` container (it is `position: relative`):

```tsx
{reviewMode && highlight && (
  <div
    className="tile-review-highlight"
    style={{
      left: highlight.rect.x,
      top: highlight.rect.y,
      width: highlight.rect.width,
      height: highlight.rect.height,
    }}
  />
)}
```

comment card and pill strip analogous (`.tile-review-card`, `.tile-review-pills`). Rects are viewport CSS pixels, which match container coordinates because the tile's viewport is derived from the container rect (`sendViewport`).
- In review mode the canvas handlers branch: `onMouseDown`/`onMouseMove` do review work instead of `send(...)`; `onWheel` unchanged; `onKeyDown`/`onKeyUp` return early.

CSS additions to `src/web-pane.css` (match the file's existing custom-property style):

```css
.tile-review-highlight {
  position: absolute;
  pointer-events: none;
  border: 2px solid var(--accent, #7c5cff);
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
}

.tile-review-card {
  position: absolute;
  z-index: 3;
  width: 240px;
  padding: 8px;
  border-radius: 8px;
  background: var(--surface-raised, #1c1826);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tile-review-card textarea {
  resize: vertical;
  min-height: 56px;
}

.tile-review-pills {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.tile-review-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--surface-raised, #1c1826);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 4: Thread through `WebPaneCard` and `App.tsx`**

Per the behavior contracts. `WebPaneCard` renders `ChromiumTileCard` with `reviewMode={review}` and `onSubmitFeedback={onSubmitFeedback ?? (async () => undefined)}`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — expected clean.
Run: `npm test` — expected all green (no component test for the overlay is required; jsdom lacks a WebSocket and the existing suite does not mock one for `ChromiumTileCard`. The overlay is covered by Task 7's pure logic tests plus Task 10's manual e2e).

- [ ] **Step 6: Commit**

```bash
git add src/webPanesApi.ts src/webPanesApi.test.ts src/ChromiumTileCard.tsx src/WebPaneCard.tsx src/App.tsx src/web-pane.css
git commit -m "feat(web): review mode on chromium tiles with queued element notes"
```

---

### Task 9: Agent helper script + skill update

**Files:**
- Create: `scripts/commando-feedback` (executable)
- Modify: `skills/show-in-commando/SKILL.md`

**Interfaces:**
- Consumes: the feedback GET route (Task 5).
- Produces: `scripts/commando-feedback <webPaneId> [--wait N]` — one long-poll round; prints the JSON body; exit 0 on success (including empty `notes`), exit 4 on 404 (tile gone — stop polling), exit 1 otherwise.

- [ ] **Step 1: Write the script**

Model it on `scripts/commando-open` (same token file resolution and env vars):

```bash
#!/usr/bin/env bash
# commando-feedback — drain one batch of review feedback from a chromium tile.
#
#   commando-feedback <webPaneId> [--wait <seconds>]
#
# Long-polls GET /api/web-panes/<id>/feedback for up to --wait seconds
# (default 30, max 60) and prints the JSON body: {"ok":true,"notes":[...]}.
# Each note carries selector, tag, text, rect, comment, pageUrl, capturedAt —
# apply the feedback, then run this again. Exit codes: 0 success (notes may
# be empty — just re-run), 4 tile gone (stop polling), 1 other errors.
set -euo pipefail

pane_id=""
wait_seconds=30
while [ $# -gt 0 ]; do
  case "$1" in
    --wait)
      wait_seconds="${2:-}"
      shift 2 || { echo "commando-feedback: --wait needs a value" >&2; exit 2; }
      ;;
    --wait=*)
      wait_seconds="${1#--wait=}"
      shift
      ;;
    -*)
      echo "commando-feedback: unknown flag $1" >&2
      exit 2
      ;;
    *)
      pane_id="$1"
      shift
      ;;
  esac
done
if [ -z "$pane_id" ]; then
  echo "usage: commando-feedback <webPaneId> [--wait <seconds>]" >&2
  exit 2
fi

token_path="${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}"
if [ ! -f "$token_path" ]; then
  echo "commando-feedback: agent hook token not found at $token_path" >&2
  exit 1
fi

port="${COMMANDO_PORT:-4310}"
url="http://127.0.0.1:${port}/api/web-panes/${pane_id}/feedback?wait=${wait_seconds}"
status=$(curl -sS -o /tmp/commando-feedback-body.$$ -w '%{http_code}' \
  --max-time "$((wait_seconds + 15))" \
  -H "Authorization: Bearer $(cat "$token_path")" \
  "$url") || { rm -f /tmp/commando-feedback-body.$$; echo "commando-feedback: daemon unreachable" >&2; exit 1; }
body=$(cat /tmp/commando-feedback-body.$$)
rm -f /tmp/commando-feedback-body.$$
echo "$body"
case "$status" in
  200) exit 0 ;;
  404) exit 4 ;;
  *) echo "commando-feedback: HTTP $status" >&2; exit 1 ;;
esac
```

`chmod +x scripts/commando-feedback`.

- [ ] **Step 2: Verify the script standalone**

Run: `bash -n scripts/commando-feedback` (syntax) and `scripts/commando-feedback 2>&1; echo "exit=$?"` — expected usage message, exit 2.

- [ ] **Step 3: Update the skill**

In `skills/show-in-commando/SKILL.md`, after the "Choosing an engine" section, add:

```markdown
## Collecting review feedback on a chromium tile

Chromium tiles have a review mode: the user toggles it in the tile header,
clicks elements on your page, and queues comments. Each note reaches you
selector-anchored — `{selector, tag, text, rect, comment, pageUrl}` — so you
can go straight from note to edit.

After opening a chromium tile for something you want reviewed, poll for
feedback in a background task and keep working:

```bash
curl -sS "http://127.0.0.1:${COMMANDO_PORT:-4310}/api/web-panes/<webPaneId>/feedback?wait=30" \
  -H "Authorization: Bearer $(cat "${COMMANDO_AGENT_HOOK_TOKEN_PATH:-$HOME/.commando/agent-hook-token}")"
# → {"ok":true,"webPaneId":"w-…","notes":[{"selector":"#root > button", "comment":"…", …}]}
```

(With a commando checkout handy, `scripts/commando-feedback <webPaneId>` wraps
this; exit 4 means the tile is gone.)

- Empty `notes` after ~30s is normal — re-poll. Draining is the ack: the tile
  shows the user "agent received N notes".
- Apply the feedback, verify over the tile's `/cdp` endpoint if useful, and
  reply in your own terminal — there is no chat panel in the tile.
- Stop polling on 404 (tile closed) and never retry a 401 in a loop.
```

Also add one line to the engine-choice section: review mode is another reason to prefer `"engine":"chromium"` when you want the user to annotate what you show them.

- [ ] **Step 4: Commit**

```bash
git add scripts/commando-feedback skills/show-in-commando/SKILL.md
git commit -m "docs(skill): review-feedback workflow and commando-feedback helper"
```

---

### Task 10: Full verification

**Files:** none new.

- [ ] **Step 1: Full static + unit pass**

Run: `npm run typecheck` — expected clean.
Run: `npm test` — expected all green.

- [ ] **Step 2: Manual end-to-end (per CLAUDE.md merge rules)**

From `/Users/leoijebor/dev/commando-tile-review`:
1. `npm run dev` (daemon + vite). Open the web client.
2. In a tmux pane the daemon mirrors, open a chromium tile on any localhost page (e.g. the vite client itself): `scripts/commando-open http://127.0.0.1:5173/ --engine chromium`.
3. Toggle review mode in the tile header. Hover — highlight boxes follow elements. Click an element — comment card opens; queue two notes on different elements.
4. Send. Then run `scripts/commando-feedback <webPaneId>` — expect both notes with sensible selectors; the tile footer shows "agent received 2 notes at …".
5. Re-run `scripts/commando-feedback <webPaneId> --wait 5` — expect empty notes after ~5s.
6. Close the tile; re-run the script — expect exit 4.
7. Verify normal (non-review) interaction still works: scroll, click, type in the tile with review mode off.

- [ ] **Step 3: Record results**

Fix anything broken before declaring done. Do NOT merge to main — leave the branch for review.
```
