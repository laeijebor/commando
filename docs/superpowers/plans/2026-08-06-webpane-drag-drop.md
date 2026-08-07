# Web Tile Drag-and-Drop, Maximize & URL Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web tiles gain three interactions: drag onto a terminal pane to re-anchor (drop position picks `right`/`below`), a maximize/restore toggle, and inline URL editing that honors the origin trust policy.

**Architecture:** A new `WebPaneService.move()` + `POST /api/web-panes/:id/move` on the daemon mutate the tile's anchor/placement (same-window enforced server-side); the client generalizes the existing HTML5 pane-drag state to a tagged union, makes the `WebPaneCard` header draggable, and turns terminal pane cards into position-sensitive drop targets with an occluder-marked preview overlay. No optimistic layout mutation — the daemon's `web_panes` broadcast re-renders the grid.

**Tech Stack:** TypeScript, Node http (daemon), React 18, vitest (+ @testing-library/react for component tests).

**Spec:** `docs/superpowers/specs/2026-08-06-webpane-drag-drop-design.md` (committed on this branch).

## Global Constraints

- Work happens on branch `feat-webpane-drag` in the worktree `/Users/leoijebor/dev/commando-webpane-drag` — never on `main`.
- Run all commands from the worktree root: `cd /Users/leoijebor/dev/commando-webpane-drag`.
- Placement stored on a `WebPane` is always concrete `'right' | 'below'` — never write `'auto'` (this invariant fixed a layout-thrash bug; see `shared/web-pane-placement.ts`).
- Moves are same-window only: a move whose target anchor is in a different tmux window must fail with HTTP 400.
- Terminal-pane drag behavior (header drag → swap on drop) must not change.
- Do not include a Claude co-author line in commits.
- Commit after every green task with a conventional message (`feat:`, `test:` …).

---

### Task 1: `WebPaneService.move()`

**Files:**
- Modify: `server/web-panes.ts` (add `MoveWebPaneTarget` type + `move()` method after `close()`, ~line 292)
- Test: `server/web-panes.test.ts` (append inside `describe('WebPaneService', …)`)

**Interfaces:**
- Consumes: existing `WebPaneService`, `WebPaneError`, `PANE_ID` regex, `persist()` — all already in `server/web-panes.ts`.
- Produces: `move(id: string, target: MoveWebPaneTarget): WebPane` where
  `type MoveWebPaneTarget = { anchorPaneId: string; placement: 'right' | 'below'; sessionId: string; windowId: string }`.
  Throws `WebPaneError(404)` for unknown ids, `WebPaneError(400)` for bad anchor ids, non-concrete placements, and cross-window targets. Task 2 calls this.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('WebPaneService', …)` block of `server/web-panes.test.ts` (the file already imports `readFile`, has `anchor`, `track`, `temporaryStatePath`):

```ts
  it('move re-anchors a tile with a new concrete placement and persists it', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    const moved = service.move(pane.id, {
      anchorPaneId: '%40',
      placement: 'below',
      sessionId: '$1',
      windowId: '@3',
    })
    expect(moved).toMatchObject({ id: pane.id, anchorPaneId: '%40', placement: 'below' })
    expect(service.get(pane.id)).toMatchObject({ anchorPaneId: '%40', placement: 'below' })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      panes: Array<{ anchorPaneId: string; placement: string }>
    }
    expect(stored.panes[0]).toMatchObject({ anchorPaneId: '%40', placement: 'below' })
  })

  it('move rejects unknown tiles, bad anchor ids, and non-concrete placements', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    const target = {
      anchorPaneId: '%40',
      placement: 'below' as const,
      sessionId: '$1',
      windowId: '@3',
    }
    expect(() => service.move('w-00000000', target)).toThrow(WebPaneError)
    expect(() => service.move(pane.id, { ...target, anchorPaneId: 'nope' })).toThrow(/anchor/i)
    expect(() => service.move(pane.id, { ...target, placement: 'auto' as never })).toThrow(/placement/i)
  })

  it('move rejects a target anchor in a different window', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(() =>
      service.move(pane.id, {
        anchorPaneId: '%40',
        placement: 'right',
        sessionId: '$1',
        windowId: '@9',
      }),
    ).toThrow(/window/i)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/web-panes.test.ts`
Expected: the three new tests FAIL with `TypeError: service.move is not a function`; every other test PASSES.

- [ ] **Step 3: Implement `move()`**

In `server/web-panes.ts`, add next to `OpenWebPaneInput` (~line 169):

```ts
export type MoveWebPaneTarget = {
  anchorPaneId: string
  placement: 'right' | 'below'
  sessionId: string
  windowId: string
}
```

Add the method to `WebPaneService`, directly after `close()`:

```ts
  /**
   * Re-anchors a tile to another pane in ITS OWN window, with a concrete
   * placement chosen by the drop position. Cross-window moves are rejected
   * here — the invariant lives in the service, not in UI reachability.
   */
  move(id: string, target: MoveWebPaneTarget): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (!PANE_ID.test(target.anchorPaneId)) throw new WebPaneError(400, 'Invalid anchor pane id')
    if (target.placement !== 'right' && target.placement !== 'below') {
      throw new WebPaneError(400, 'Move placement must be right or below')
    }
    if (target.windowId !== pane.windowId) {
      throw new WebPaneError(400, 'Web panes can only move within their window')
    }
    const moved: WebPane = {
      ...pane,
      anchorPaneId: target.anchorPaneId,
      placement: target.placement,
      sessionId: target.sessionId,
      windowId: target.windowId,
    }
    this.panes.set(id, moved)
    this.persist()
    return moved
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/web-panes.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/web-panes.ts server/web-panes.test.ts
git commit -m "feat(server): WebPaneService.move re-anchors a tile within its window"
```

---

### Task 2: `POST /api/web-panes/:id/move`

**Files:**
- Modify: `server/web-panes-api.ts` (route parser ~line 230, handler in `handle()` after the `confirm` branch ~line 186)
- Test: `server/web-panes-api.test.ts`

**Interfaces:**
- Consumes: `service.move(id, { anchorPaneId, placement, sessionId, windowId })` from Task 1; existing `paneForId` dependency (returns `{ id, sessionId, windowId, width, height }`), `openLimiter`, `onChange`.
- Produces: HTTP endpoint `POST /api/web-panes/:id/move` with JSON body `{ anchor: string, placement: 'right' | 'below' }`, responding `200 { ok: true, webPaneId, beside, placement }`. Task 3's client calls it.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('web panes API', …)` block of `server/web-panes-api.test.ts` (the file already has `createService`, `startApi`, `post`, `ownerAuth`, `agentAuth`; `startApi`'s default `paneForId` only knows `%12`):

```ts
  it('moves a tile to a new anchor with the previewed placement', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service, {
      paneForId: (paneId) =>
        paneId === '%12'
          ? { id: '%12', sessionId: '$1', windowId: '@3', width: 190, height: 55 }
          : paneId === '%40'
            ? { id: '%40', sessionId: '$1', windowId: '@3', width: 95, height: 55 }
            : undefined,
    })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%40', placement: 'below' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      webPaneId: opened.id,
      beside: '%40',
      placement: 'below',
    })
    expect(service.get(opened.id)).toMatchObject({ anchorPaneId: '%40', placement: 'below' })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('rejects a move whose target anchor lives in another window', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service, {
      paneForId: (paneId) =>
        paneId === '%12'
          ? { id: '%12', sessionId: '$1', windowId: '@3', width: 190, height: 55 }
          : paneId === '%50'
            ? { id: '%50', sessionId: '$1', windowId: '@9', width: 190, height: 55 }
            : undefined,
    })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%50', placement: 'right' },
      ownerAuth,
    )
    expect(response.status).toBe(400)
    expect(service.get(opened.id)?.anchorPaneId).toBe('%12')
  })

  it('rejects a move to an unknown anchor pane or with a bad placement', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const unknownAnchor = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%99', placement: 'right' },
      ownerAuth,
    )
    expect(unknownAnchor.status).toBe(404)

    const autoPlacement = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%12', placement: 'auto' },
      ownerAuth,
    )
    expect(autoPlacement.status).toBe(400)

    const unauthenticated = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%12', placement: 'right' },
    )
    expect(unauthenticated.status).toBe(401)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/web-panes-api.test.ts`
Expected: the three new tests FAIL — the happy path with 404 (route parser rejects `/move`), the others likewise. All existing tests PASS.

- [ ] **Step 3: Implement the route**

In `server/web-panes-api.ts`:

1. Extend the route parser (`private route(...)`, ~line 230) to accept `move`:

```ts
  private route(pathname: string): { kind: 'collection' } | { kind: 'pane'; id: string; action: 'confirm' | 'cdp' | 'move' | 'delete' } {
    if (pathname === API_ROOT) return { kind: 'collection' }
    const match = /^\/api\/web-panes\/([^/]+)(?:\/(confirm|cdp|move))?$/.exec(pathname)
    if (!match || !WEB_PANE_ID.test(match[1])) throw new HttpError(404, 'Not found')
    const action = match[2] === 'confirm'
      ? 'confirm'
      : match[2] === 'cdp'
        ? 'cdp'
        : match[2] === 'move' ? 'move' : 'delete'
    return { kind: 'pane', id: match[1], action }
  }
```

2. Add the handler branch in `handle()`, directly after the `route.action === 'confirm'` block:

```ts
      if (route.action === 'move') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        if (!this.openLimiter.take(1)) throw new HttpError(429, 'Too many web pane requests')
        const body = await readJson(request)
        const { anchor, placement } = body
        if (typeof anchor !== 'string' || !PANE_ID.test(anchor)) {
          throw new HttpError(400, 'anchor must be a tmux pane id')
        }
        if (placement !== 'right' && placement !== 'below') {
          throw new HttpError(400, 'placement must be right or below')
        }
        const anchorPane = this.dependencies.paneForId(anchor)
        if (!anchorPane) throw new HttpError(404, 'Anchor tmux pane does not exist')
        const pane = this.dependencies.service.move(route.id, {
          anchorPaneId: anchorPane.id,
          placement,
          sessionId: anchorPane.sessionId,
          windowId: anchorPane.windowId,
        })
        this.dependencies.onChange()
        writeJson(response, 200, {
          ok: true,
          webPaneId: pane.id,
          beside: pane.anchorPaneId,
          placement: pane.placement,
        })
        return true
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/web-panes-api.test.ts server/web-panes.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/web-panes-api.ts server/web-panes-api.test.ts
git commit -m "feat(server): POST /api/web-panes/:id/move endpoint"
```

---

### Task 3: client `webPanesApi.move()`

**Files:**
- Modify: `src/webPanesApi.ts`
- Test: Create `src/webPanesApi.test.ts`

**Interfaces:**
- Consumes: the Task 2 endpoint.
- Produces: `move(webPaneId: string, anchor: string, placement: 'right' | 'below'): Promise<void>` on `WebPanesApiClient`. Task 6 calls it.

- [ ] **Step 1: Write the failing tests**

Create `src/webPanesApi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createWebPanesApi } from './webPanesApi'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('webPanesApi.move', () => {
  it('posts the anchor and placement to the move endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await api.move('w-0badcafe', '%40', 'below')

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/web-panes/w-0badcafe/move')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ anchor: '%40', placement: 'below' }))
  })

  it('surfaces the server error message', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(400, { error: 'Web panes can only move within their window' }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await expect(api.move('w-0badcafe', '%40', 'right')).rejects.toThrow(/within their window/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webPanesApi.test.ts`
Expected: FAIL — `api.move is not a function`.

- [ ] **Step 3: Implement `move`**

In `src/webPanesApi.ts`, add to the `WebPanesApiClient` interface (after `confirm`):

```ts
  move(webPaneId: string, anchor: string, placement: 'right' | 'below'): Promise<void>
```

Add to the returned object in `createWebPanesApi` (after `confirm`):

```ts
    move: async (webPaneId, anchor, placement) => {
      await request(`/${encodeURIComponent(webPaneId)}/move`, {
        method: 'POST',
        body: JSON.stringify({ anchor, placement }),
      })
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webPanesApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webPanesApi.ts src/webPanesApi.test.ts
git commit -m "feat(web): webPanesApi.move client method"
```

---

### Task 4: `paneDrag` module — drag payload type and drop-placement helper

**Files:**
- Create: `src/paneDrag.ts`
- Test: Create `src/paneDrag.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DraggedItem = { kind: 'terminal'; groupId: string; paneId: string } | { kind: 'web'; groupId: string; webPaneId: string }`
  - `dropPlacementFor(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): 'right' | 'below'`
  Task 6 uses both.

- [ ] **Step 1: Write the failing tests**

Create `src/paneDrag.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dropPlacementFor } from './paneDrag'

const rect = { left: 100, top: 200, width: 400, height: 300 }

describe('dropPlacementFor', () => {
  it('previews a right anchor in the right half', () => {
    expect(dropPlacementFor(rect, 100 + 360, 200 + 150)).toBe('right')
  })

  it('previews a below anchor in the bottom half', () => {
    expect(dropPlacementFor(rect, 100 + 120, 200 + 270)).toBe('below')
  })

  it('breaks the bottom-right corner tie toward the larger fraction', () => {
    // x-fraction 0.9 > y-fraction 0.8 → right
    expect(dropPlacementFor(rect, 100 + 360, 200 + 240)).toBe('right')
    // x-fraction 0.6 < y-fraction 0.8 → below
    expect(dropPlacementFor(rect, 100 + 240, 200 + 240)).toBe('below')
  })

  it('defaults to right for a degenerate rect', () => {
    expect(dropPlacementFor({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe('right')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/paneDrag.test.ts`
Expected: FAIL — cannot find module `./paneDrag`.

- [ ] **Step 3: Implement the module**

Create `src/paneDrag.ts`:

```ts
/** What a drag in the pane grid is carrying. */
export type DraggedItem =
  | { kind: 'terminal'; groupId: string; paneId: string }
  | { kind: 'web'; groupId: string; webPaneId: string }

/**
 * Which placement a web-tile drop at (clientX, clientY) over a pane card
 * previews. The card splits along its top-left→bottom-right diagonal: the
 * upper-right triangle anchors the tile to the right, the lower-left
 * anchors it below — equivalently, whichever fractional coordinate is
 * larger wins, which is the "right half → right, bottom half → below"
 * rule with a deterministic corner tie-break.
 */
export function dropPlacementFor(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): 'right' | 'below' {
  if (rect.width <= 0 || rect.height <= 0) return 'right'
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  return x >= y ? 'right' : 'below'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/paneDrag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paneDrag.ts src/paneDrag.test.ts
git commit -m "feat(web): paneDrag module — DraggedItem union and dropPlacementFor"
```

---

### Task 5: draggable `WebPaneCard` header

**Files:**
- Modify: `src/WebPaneCard.tsx` (props ~lines 50-66, header element ~line 117)
- Test: Create `src/WebPaneCard.test.tsx`

**Interfaces:**
- Consumes: React `DragEvent` type.
- Produces: optional `WebPaneCard` props `onDragStart?: (event: DragEvent<HTMLElement>) => void` and `onDragEnd?: () => void`; the `web-pane-head` header is `draggable` exactly when `onDragStart` is provided. Task 6 passes both.

- [ ] **Step 1: Write the failing test**

Create `src/WebPaneCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { WebPaneCard } from './WebPaneCard'

const webPane: WebPane = {
  id: 'w-0badcafe',
  url: 'http://localhost:5173/plan',
  sessionId: '$1',
  windowId: '@3',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'webkit',
  openedBy: 'user',
  status: 'open',
  createdAt: Date.now(),
}

describe('WebPaneCard dragging', () => {
  it('makes the header draggable and forwards drag start/end', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    )

    const header = screen.getByTitle('Drag onto a terminal pane to move this tile')
    expect(header).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(header)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    fireEvent.dragEnd(header)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('is not draggable without a drag handler', () => {
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
      />,
    )
    expect(document.querySelector('.web-pane-head')).toHaveAttribute('draggable', 'false')
  })
})
```

Note: if `WebPaneCard`'s current props require fields not listed here (check the actual props type at `src/WebPaneCard.tsx:50-66` before writing), pass the minimal extra props the type demands — but do not add new required props.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/WebPaneCard.test.tsx`
Expected: FAIL — no element with title `Drag onto a terminal pane to move this tile` / `draggable` attribute missing.

- [ ] **Step 3: Implement the draggable header**

In `src/WebPaneCard.tsx`:

1. Add to the props type (make both optional):

```ts
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
```

and import the type: `import type { DragEvent } from 'react'` (merge with existing react imports). Destructure `onDragStart, onDragEnd` alongside the other props.

2. Change the header element:

```tsx
      <header
        className="web-pane-head"
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={onDragStart ? 'Drag onto a terminal pane to move this tile' : undefined}
      >
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/WebPaneCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/WebPaneCard.tsx src/WebPaneCard.test.tsx
git commit -m "feat(web): draggable web tile header"
```

---

### Task 6: App wiring — tagged drag state, drop preview, move dispatch

**Files:**
- Modify: `src/App.tsx` (state ~line 818, `dropPane` ~line 1417, `TerminalPaneProps`/card ~lines 283-431, card wiring ~lines 2305-2321, `WebPaneCard` wiring ~line 2345, a `moveWebPane` helper next to `closeWebPane` ~line 1639)
- Modify: `src/styles.css` (append)
- Test: `src/App.test.tsx` (append)

**Interfaces:**
- Consumes: `DraggedItem`, `dropPlacementFor` (Task 4); `webPanesApi.move` (Task 3); `WebPaneCard` drag props (Task 5).
- Produces: user-facing behavior; no new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/App.test.tsx` a test in the style of the existing workspace tests (reuse the file's existing render/snapshot helpers — look at how the current drag/swap or web-pane tests set up a session with panes and web panes). The test must assert:

```tsx
  it('re-anchors a web tile dropped on the bottom half of a terminal pane', async () => {
    // Arrange: render a workspace with two terminal panes (%1, %2) in one
    // window and one web tile anchored to %1, using this file's existing
    // snapshot/web_panes fixtures. Capture calls to the web panes API by
    // stubbing fetch the same way existing web-pane tests in this file do.
    // Act:
    //   1. fireEvent.dragStart on the web tile header
    //      (screen.getByTitle('Drag onto a terminal pane to move this tile'))
    //   2. fireEvent.dragOver on the %2 pane card at clientY in its bottom
    //      half (mock getBoundingClientRect on the card to a known rect,
    //      e.g. { left: 0, top: 0, width: 400, height: 300 }, and use
    //      clientX: 100, clientY: 280)
    //   3. assert the card shows the preview: the element
    //      `.pane-drop-preview.is-below` exists and carries the
    //      `data-native-terminal-occluder` attribute
    //   4. fireEvent.drop on the same card
    // Assert: fetch was called with POST /api/web-panes/<id>/move and body
    // { anchor: '%2', placement: 'below' }, and the preview element is gone.
  })
```

Write the real test (no comments-only body) by adapting the arrange/stub helpers that already exist in `src/App.test.tsx` — e.g. its existing `web_panes` message fixtures and fetch stubs. Also add the inverse guard:

```tsx
  it('keeps terminal-pane drops on the swap path', async () => {
    // Arrange as above. Drag terminal pane %1's header (title contains
    // 'Drag to reorder this pane') and drop it on %2's card.
    // Assert: the websocket send spy saw a set_window_layout message whose
    // leaf order swaps %1 and %2, and NO fetch to /api/web-panes/... /move
    // happened.
  })
```

(If an equivalent swap assertion already exists in the file, extend it with the no-move-call assertion instead of duplicating it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: the new tile test FAILS (no draggable tile header / no preview / no move call). Existing tests PASS.

- [ ] **Step 3: Implement the wiring**

All in `src/App.tsx` unless noted.

1. Import from the new module:

```ts
import { dropPlacementFor, type DraggedItem } from './paneDrag'
```

2. Replace the drag state (line ~818) and add preview state:

```ts
  const [draggedPane, setDraggedPane] = useState<DraggedItem | null>(null)
  const [dropPreview, setDropPreview] = useState<{ paneId: string; placement: 'right' | 'below' } | null>(null)
```

3. Update the terminal-pane drag start (card wiring ~line 2305) to tag the kind:

```tsx
                            onDragStart={(event) => {
                              setDraggedPane({ kind: 'terminal', groupId: group.id, paneId: pane.id })
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', pane.id)
                            }}
                            onDragEnd={() => {
                              setDraggedPane(null)
                              setDropPreview(null)
                            }}
```

4. Replace the card's `onDragOver`/`onDrop` wiring:

```tsx
                            onDragOver={(event) => {
                              if (draggedPane?.groupId !== group.id) return
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                              if (draggedPane.kind !== 'web') return
                              const placement = dropPlacementFor(
                                event.currentTarget.getBoundingClientRect(),
                                event.clientX,
                                event.clientY,
                              )
                              setDropPreview((current) =>
                                current?.paneId === pane.id && current.placement === placement
                                  ? current
                                  : { paneId: pane.id, placement })
                            }}
                            onDragLeave={() => {
                              setDropPreview((current) => (current?.paneId === pane.id ? null : current))
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              clearLayoutTimers()
                              dropPane(group.windowId, group.id, pane.id, event)
                            }}
```

5. Rework `dropPane` (~line 1417) to branch on the drag kind, and add `moveWebPane` next to `closeWebPane` (~line 1639):

```ts
  const dropPane = (
    windowId: string,
    groupId: string,
    targetPaneId: string,
    event: DragEvent<HTMLElement>,
  ) => {
    const dragged = draggedPane
    setDraggedPane(null)
    setDropPreview(null)
    if (!dragged || dragged.groupId !== groupId) return
    if (dragged.kind === 'terminal') {
      if (dragged.paneId === targetPaneId) return
      swapWindowPanes(windowId, dragged.paneId, targetPaneId)
      return
    }
    const placement = dropPlacementFor(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    )
    void moveWebPane(dragged.webPaneId, targetPaneId, placement)
  }
```

```ts
  const moveWebPane = async (
    webPaneId: string,
    anchor: string,
    placement: 'right' | 'below',
  ) => {
    setPaneActionError('')
    try {
      await webPanesApi.move(webPaneId, anchor, placement)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to move web pane')
    }
  }
```

(`TerminalPaneProps.onDrop` already receives the event; update `onDragLeave` in the props type: add `onDragLeave: () => void` at ~line 290 and thread it onto the `<article>` in `TerminalPaneCard` alongside the existing `onDragOver`/`onDrop`.)

6. Render the preview overlay inside `TerminalPaneCard`'s `<article>` (after the header). Add a prop `dropPreview: 'right' | 'below' | null` to `TerminalPaneProps`, pass it from the wiring as `dropPreview={dropPreview?.paneId === pane.id ? dropPreview.placement : null}`, and render:

```tsx
      {dropPreview && (
        <div
          className={`pane-drop-preview is-${dropPreview}`}
          data-native-terminal-occluder=""
          aria-hidden="true"
        />
      )}
```

7. Wire the tile side (WebPaneCard usage, ~line 2345) — inside the `groupWebPanes.map`:

```tsx
                          onDragStart={(event) => {
                            setDraggedPane({ kind: 'web', groupId: group.id, webPaneId: webPane.id })
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', webPane.id)
                          }}
                          onDragEnd={() => {
                            setDraggedPane(null)
                            setDropPreview(null)
                          }}
```

8. Append to `src/styles.css` (`.terminal-pane` already has `position: relative`):

```css
.pane-drop-preview {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: color-mix(in srgb, var(--surface-hover) 65%, transparent);
  border: 1px solid var(--border);
  z-index: 4;
}

.pane-drop-preview.is-right {
  left: 50%;
}

.pane-drop-preview.is-below {
  top: 50%;
}
```

(Match the file's existing custom-property names — if `--surface-hover`/`--border` do not exist in `src/styles.css`, use the closest existing surface/border variables from that file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/App.test.tsx src/WebPaneCard.test.tsx`
Expected: all PASS, including the drag tests from Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(web): drag a web tile onto a terminal pane to re-anchor it"
```

---

### Task 7: `WebPaneService.navigate()`

**Files:**
- Modify: `server/web-panes.ts` (add `navigate()` after `move()`)
- Test: `server/web-panes.test.ts` (append inside `describe('WebPaneService', …)`)

**Interfaces:**
- Consumes: existing `classifyWebPaneUrl`, `WebPaneError`, `persist()`.
- Produces: `navigate(id: string, url: string): WebPane` — swaps the tile's URL through the open-time trust policy: invalid → `WebPaneError(400)`, unknown id → `WebPaneError(404)`, localhost/allowlisted → `status: 'open'`, unconfirmed external → `status: 'pending'`. Task 8 calls this.

- [ ] **Step 1: Write the failing tests**

Append to `server/web-panes.test.ts`:

```ts
  it('navigate swaps the url and keeps localhost tiles open', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    const navigated = service.navigate(pane.id, 'http://127.0.0.1:4310/other')
    expect(navigated).toMatchObject({ url: 'http://127.0.0.1:4310/other', status: 'open' })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { panes: Array<{ url: string }> }
    expect(stored.panes[0].url).toBe('http://127.0.0.1:4310/other')
  })

  it('navigate to an unconfirmed external origin flips the tile to pending', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(service.navigate(pane.id, 'https://reactnative.dev/docs')).toMatchObject({
      url: 'https://reactnative.dev/docs',
      status: 'pending',
    })
  })

  it('navigate to an allowlisted external origin stays open', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pending = service.open({ ...anchor, url: 'https://reactnative.dev/docs' })
    service.confirm(pending.id, true)
    expect(service.navigate(pending.id, 'https://reactnative.dev/blog')).toMatchObject({
      status: 'open',
    })
  })

  it('navigate rejects invalid urls and unknown tiles', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(() => service.navigate(pane.id, 'ftp://example.com/')).toThrow(WebPaneError)
    expect(() => service.navigate('w-00000000', 'http://localhost:5173/')).toThrow(WebPaneError)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/web-panes.test.ts`
Expected: the four new tests FAIL with `service.navigate is not a function`.

- [ ] **Step 3: Implement `navigate()`**

Add to `WebPaneService` directly after `move()`:

```ts
  /**
   * Swaps a tile's URL through the same trust policy as open: localhost and
   * allowlisted origins stay open; an unconfirmed external origin flips the
   * tile to pending so URL editing cannot bypass the origin gate.
   */
  navigate(id: string, url: string): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    const decision = classifyWebPaneUrl(url, this.allowedOrigins)
    if (decision.kind === 'invalid') throw new WebPaneError(400, decision.reason)
    const navigated: WebPane = {
      ...pane,
      url: decision.url,
      status: decision.kind === 'open' ? 'open' : 'pending',
    }
    this.panes.set(id, navigated)
    this.persist()
    return navigated
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/web-panes.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/web-panes.ts server/web-panes.test.ts
git commit -m "feat(server): WebPaneService.navigate swaps a tile url through the trust policy"
```

---

### Task 8: `POST /api/web-panes/:id/navigate`

**Files:**
- Modify: `server/web-panes-api.ts` (route parser + handler branch after the `move` branch from Task 2)
- Test: `server/web-panes-api.test.ts`

**Interfaces:**
- Consumes: `service.navigate(id, url)` from Task 7; existing `onConfirmed` dependency (the daemon already uses it to navigate a chromium tile's managed target — see `server/index.ts:1187`).
- Produces: `POST /api/web-panes/:id/navigate` with body `{ url: string }` → `200 { ok: true, webPaneId, status, url }`. Fires `onConfirmed(pane)` only when the result is `open`. Task 9's client calls it.

- [ ] **Step 1: Write the failing tests**

Append to `server/web-panes-api.test.ts`:

```ts
  it('navigates a tile to a new url and syncs the engine when it stays open', async () => {
    const service = await createService()
    const onConfirmed = vi.fn()
    const { baseUrl, onChange } = await startApi(service, { onConfirmed })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'http://127.0.0.1:4310/report' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      webPaneId: opened.id,
      status: 'open',
      url: 'http://127.0.0.1:4310/report',
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('navigating to an unconfirmed external origin pends without engine sync', async () => {
    const service = await createService()
    const onConfirmed = vi.fn()
    const { baseUrl } = await startApi(service, { onConfirmed })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'https://reactnative.dev/docs' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'pending' })
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it('navigate requires auth and a string url', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    expect((await post(baseUrl, `/api/web-panes/${opened.id}/navigate`, { url: 'http://localhost:1/' })).status).toBe(401)
    expect((await post(baseUrl, `/api/web-panes/${opened.id}/navigate`, { url: 42 }, ownerAuth)).status).toBe(400)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/web-panes-api.test.ts`
Expected: the three new tests FAIL (404 from the route parser).

- [ ] **Step 3: Implement the route**

In `server/web-panes-api.ts`:

1. Extend the route parser union and regex (which after Task 2 already contains `move`):

```ts
  private route(pathname: string): { kind: 'collection' } | { kind: 'pane'; id: string; action: 'confirm' | 'cdp' | 'move' | 'navigate' | 'delete' } {
    if (pathname === API_ROOT) return { kind: 'collection' }
    const match = /^\/api\/web-panes\/([^/]+)(?:\/(confirm|cdp|move|navigate))?$/.exec(pathname)
    if (!match || !WEB_PANE_ID.test(match[1])) throw new HttpError(404, 'Not found')
    const action = match[2] === 'confirm'
      ? 'confirm'
      : match[2] === 'cdp'
        ? 'cdp'
        : match[2] === 'move'
          ? 'move'
          : match[2] === 'navigate' ? 'navigate' : 'delete'
    return { kind: 'pane', id: match[1], action }
  }
```

2. Add the handler branch directly after the `move` branch:

```ts
      if (route.action === 'navigate') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        if (!this.openLimiter.take(1)) throw new HttpError(429, 'Too many web pane requests')
        const body = await readJson(request)
        if (typeof body.url !== 'string') throw new HttpError(400, 'url must be a string')
        const pane = this.dependencies.service.navigate(route.id, body.url)
        if (pane.status === 'open') this.dependencies.onConfirmed?.(pane)
        this.dependencies.onChange()
        writeJson(response, 200, {
          ok: true,
          webPaneId: pane.id,
          status: pane.status,
          url: pane.url,
        })
        return true
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/web-panes-api.test.ts server/web-panes.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/web-panes-api.ts server/web-panes-api.test.ts
git commit -m "feat(server): POST /api/web-panes/:id/navigate endpoint"
```

---

### Task 9: client URL editing — `webPanesApi.navigate` + inline editor in the tile header

**Files:**
- Modify: `src/webPanesApi.ts`, `src/WebPaneCard.tsx`, `src/App.tsx` (a `navigateWebPane` helper next to `moveWebPane`, prop wiring at the `WebPaneCard` usage), `src/styles.css` (append)
- Test: `src/webPanesApi.test.ts`, `src/WebPaneCard.test.tsx`

**Interfaces:**
- Consumes: Task 8 endpoint; `WebPaneCard` props from Task 5.
- Produces: `navigate(webPaneId: string, url: string): Promise<void>` on `WebPanesApiClient`; `WebPaneCard` prop `onNavigate?: (url: string) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/webPanesApi.test.ts` (inside a new describe or alongside the move tests):

```ts
describe('webPanesApi.navigate', () => {
  it('posts the url to the navigate endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await api.navigate('w-0badcafe', 'http://localhost:4310/report')

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/web-panes/w-0badcafe/navigate')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ url: 'http://localhost:4310/report' }))
  })
})
```

Append to `src/WebPaneCard.test.tsx`:

```tsx
describe('WebPaneCard url editing', () => {
  it('opens an inline editor and commits a new url on Enter', () => {
    const onNavigate = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change URL' }))
    const input = screen.getByRole('textbox', { name: 'Web pane URL' })
    expect(input).toHaveValue('http://localhost:5173/plan')
    fireEvent.change(input, { target: { value: 'http://localhost:4310/report' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('http://localhost:4310/report')
  })

  it('cancels the editor on Escape without navigating', () => {
    const onNavigate = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change URL' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Web pane URL' }), { key: 'Escape' })
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Web pane URL' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/webPanesApi.test.ts src/WebPaneCard.test.tsx`
Expected: FAIL — `api.navigate` missing; no `Change URL` button.

- [ ] **Step 3: Implement**

1. `src/webPanesApi.ts` — interface entry after `move`:

```ts
  navigate(webPaneId: string, url: string): Promise<void>
```

and implementation:

```ts
    navigate: async (webPaneId, url) => {
      await request(`/${encodeURIComponent(webPaneId)}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      })
    },
```

2. `src/WebPaneCard.tsx` — add prop `onNavigate?: (url: string) => void`; add state `const [urlDraft, setUrlDraft] = useState<string | null>(null)` (null = not editing). Replace the URL span: when `onNavigate` is set and not editing, wrap the URL text in a button that opens the editor; when editing, render a form:

```tsx
        {urlDraft !== null && onNavigate ? (
          <form
            className="web-pane-url-form"
            onSubmit={(event) => {
              event.preventDefault()
              const next = urlDraft.trim()
              if (next && next !== webPane.url) onNavigate(next)
              setUrlDraft(null)
            }}
          >
            <input
              value={urlDraft}
              aria-label="Web pane URL"
              autoFocus
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={() => setUrlDraft(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setUrlDraft(null)
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  const next = urlDraft.trim()
                  if (next && next !== webPane.url) onNavigate(next)
                  setUrlDraft(null)
                }
              }}
            />
          </form>
        ) : onNavigate ? (
          <button
            type="button"
            className="web-pane-url is-editable"
            title="Change URL"
            aria-label="Change URL"
            onClick={() => setUrlDraft(webPane.url)}
          >
            <span className="web-pane-host">{host}</span>
            {path ? <span className="web-pane-path">{path}</span> : null}
          </button>
        ) : (
          <span className="web-pane-url" title={webPane.url}>
            <span className="web-pane-host">{host}</span>
            {path ? <span className="web-pane-path">{path}</span> : null}
          </span>
        )}
```

(Keep both Enter-commit paths — form submit and keyDown — identical; jsdom drives keyDown, browsers drive submit.)

3. `src/App.tsx` — helper next to `moveWebPane`:

```ts
  const navigateWebPane = async (webPaneId: string, url: string) => {
    setPaneActionError('')
    try {
      await webPanesApi.navigate(webPaneId, url)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to change web pane URL')
    }
  }
```

and at the `WebPaneCard` usage add `onNavigate={(url) => void navigateWebPane(webPane.id, url)}`.

4. `src/styles.css` — append, matching the existing `.web-pane-url` typography:

```css
.web-pane-url.is-editable {
  background: none;
  border: 0;
  padding: 0;
  cursor: text;
  font: inherit;
  color: inherit;
}

.web-pane-url-form {
  flex: 1;
  min-width: 0;
}

.web-pane-url-form input {
  width: 100%;
  background: var(--surface-deep);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: inherit;
  font: inherit;
  padding: 1px 6px;
}
```

(As in Task 6: if `--surface-deep`/`--border` are not the file's variable names, use the closest existing ones.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/webPanesApi.test.ts src/WebPaneCard.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webPanesApi.ts src/webPanesApi.test.ts src/WebPaneCard.tsx src/WebPaneCard.test.tsx src/App.tsx src/styles.css
git commit -m "feat(web): inline url editing for web tiles"
```

---

### Task 10: maximize/restore a web tile

**Files:**
- Modify: `src/WebPaneCard.tsx` (header buttons), `src/App.tsx` (group rendering ~lines 2182-2206 and the `WebPaneCard` usage)
- Test: `src/WebPaneCard.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: existing `maximizedPaneId` state and `workspace-canvas … maximized` class; `isWebPaneLeafId` from `src/webPaneLayout.ts`; `Maximize2`/`Minimize2` lucide icons (already used by the terminal card in `src/App.tsx`).
- Produces: `WebPaneCard` props `maximized?: boolean` and `onMaximize?: () => void`; user-facing maximize behavior.

- [ ] **Step 1: Write the failing tests**

Append to `src/WebPaneCard.test.tsx`:

```tsx
describe('WebPaneCard maximize', () => {
  it('renders a maximize toggle that reflects and flips the state', () => {
    const onMaximize = vi.fn()
    const { rerender } = render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        maximized={false}
        onMaximize={onMaximize}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    expect(onMaximize).toHaveBeenCalledTimes(1)

    rerender(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        maximized
        onMaximize={onMaximize}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore web pane' })).toBeInTheDocument()
  })
})
```

Append to `src/App.test.tsx` (using the file's existing workspace + web_panes fixtures, as in Task 6):

```tsx
  it('maximizes a web tile to fill the canvas and restores the grid', async () => {
    // Arrange: workspace with terminal panes %1, %2 and one web tile.
    // Act: click the tile's 'Maximize web pane' button.
    // Assert: the canvas element has the 'maximized' class, the tile card
    // is rendered, and no terminal pane card is rendered.
    // Act: click 'Restore web pane'.
    // Assert: the 'maximized' class is gone and both terminal panes render.
  })
```

Write the real test body against the file's existing helpers — the assertions to make are exactly those in the comments.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/WebPaneCard.test.tsx src/App.test.tsx`
Expected: FAIL — no `Maximize web pane` button.

- [ ] **Step 3: Implement**

1. `src/WebPaneCard.tsx` — props `maximized?: boolean; onMaximize?: () => void`; import `Maximize2, Minimize2` from `lucide-react` (merge with existing import). Add the button in the header directly before the reload button:

```tsx
        {onMaximize && (
          <button
            type="button"
            className="web-pane-button"
            onClick={onMaximize}
            title={maximized ? 'Restore web pane' : 'Maximize web pane'}
            aria-label={maximized ? 'Restore web pane' : 'Maximize web pane'}
          >
            {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
        )}
```

2. `src/App.tsx` — import `isWebPaneLeafId` from `./webPaneLayout` (merge with the existing `insertWebPaneLeaves` import). In the group render block (~lines 2182-2206), replace the maximize-related derivations:

```tsx
              const visibleGroupPanes = maximizedPaneId
                ? groupPanes.filter((pane) => pane.id === maximizedPaneId)
                : groupPanes
              const maximizedWebPaneId =
                maximizedPaneId && isWebPaneLeafId(maximizedPaneId) ? maximizedPaneId : null
              if (maximizedPaneId && !maximizedWebPaneId && visibleGroupPanes.length === 0) return null

              const window = windowMap.get(group.windowId)
              const windowTree = window ? parseWindowLayout(window.layout) : null
              const visibleTree = windowTree
                ? filterLayoutTree(windowTree, new Set(visibleGroupPanes.map((pane) => pane.id)))
                : null
              // Web pane tiles join the rendered tree only: every tmux write
              // path re-derives its tree from tmux's layout string, so these
              // synthetic leaves can never reach a LayoutSpec.
              const groupWebPanes = maximizedPaneId
                ? webPanes.filter((webPane) =>
                    webPane.id === maximizedWebPaneId && webPane.windowId === group.windowId)
                : webPanes.filter((webPane) => webPane.windowId === group.windowId)
              const maximizedWebPane = groupWebPanes.find((webPane) => webPane.id === maximizedWebPaneId) ?? null
              if (maximizedWebPaneId && !maximizedWebPane) return null
              const displayTree: WindowLayoutNode | null = maximizedWebPane
                ? { kind: 'pane', paneId: maximizedWebPane.id, cols: 80, rows: 24, left: 0, top: 0 }
                : visibleTree && groupWebPanes.length > 0
                  ? insertWebPaneLeaves(visibleTree, groupWebPanes)
                  : visibleTree
```

and relax the render gate from `displayTree && visibleGroupPanes.length` to:

```tsx
                  {displayTree && (visibleGroupPanes.length || maximizedWebPane) ? (
```

3. `src/App.tsx` — at the `WebPaneCard` usage add:

```tsx
                          maximized={maximizedPaneId === webPane.id}
                          onMaximize={() => {
                            clearLayoutTimers()
                            setMaximizedPaneId((current) => (current === webPane.id ? null : webPane.id))
                          }}
```

(`WindowLayoutNode` is already imported in `src/App.tsx`; if not, import the type from `../shared/window-layout`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/WebPaneCard.test.tsx src/App.test.tsx`
Expected: all PASS, including the terminal-pane maximize tests that already exist.

- [ ] **Step 5: Commit**

```bash
git add src/WebPaneCard.tsx src/WebPaneCard.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(web): maximize/restore toggle for web tiles"
```

---

### Task 11: Verification — full suite, e2e against an isolated stack

**Files:**
- No production changes. Fixes only if verification fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch ready for the user's manual AppKit check and merge.

- [ ] **Step 1: Typecheck and full test suite**

Run: `npm run typecheck && npm test`
Expected: both green. Fix anything red before proceeding (in this worktree, committing fixes with `fix:` messages).

- [ ] **Step 2: End-to-end move against an isolated stack**

Never point a test daemon at the default tmux server. Use an isolated socket:

```bash
tmux -L cmdo-drag-e2e kill-server 2>/dev/null
tmux -L cmdo-drag-e2e new-session -d -s repro -x 200 -y 50
tmux -L cmdo-drag-e2e split-window -h -t repro
tmux -L cmdo-drag-e2e list-panes -t repro -F '#{pane_id}'   # expect %0 and %1

COMMANDO_PORT=4713 COMMANDO_TOKEN=drag-e2e-token-0123456789abcdef \
  COMMANDO_TMUX_SOCKET_NAME=cmdo-drag-e2e \
  COMMANDO_WEB_PANES_PATH=/tmp/cmdo-drag-e2e-web-panes.json \
  npx tsx server/index.ts &   # note the PID; kill it when done
sleep 5

auth='Authorization: Bearer drag-e2e-token-0123456789abcdef'
open_response=$(curl -s -X POST http://127.0.0.1:4713/api/web-panes \
  -H "$auth" -H 'Content-Type: application/json' \
  --data '{"url":"http://localhost:5173/","anchor":"%0"}')
echo "$open_response"           # note the webPaneId
id=$(echo "$open_response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["webPaneId"])')

curl -s -X POST "http://127.0.0.1:4713/api/web-panes/$id/move" \
  -H "$auth" -H 'Content-Type: application/json' \
  --data '{"anchor":"%1","placement":"below"}'
# expect {"ok":true,...,"beside":"%1","placement":"below"}

curl -s "http://127.0.0.1:4713/api/web-panes" -H "$auth"
# expect the pane record with anchorPaneId %1, placement below

curl -s -X POST "http://127.0.0.1:4713/api/web-panes/$id/navigate" \
  -H "$auth" -H 'Content-Type: application/json' \
  --data '{"url":"http://127.0.0.1:4713/other"}'
# expect {"ok":true,...,"status":"open","url":"http://127.0.0.1:4713/other"}

curl -s -X POST "http://127.0.0.1:4713/api/web-panes/$id/navigate" \
  -H "$auth" -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/"}'
# expect {"ok":true,...,"status":"pending"} — external origin pends
```

Then clean up: kill the daemon PID and `tmux -L cmdo-drag-e2e kill-server`, remove `/tmp/cmdo-drag-e2e-web-panes.json`.

- [ ] **Step 3: Report for manual check — do NOT merge yet**

Summarize what changed and ask the user to try the drag in their AppKit app (their live daemon needs a restart to pick up the new endpoint). Merging into `main` (`git -C /Users/leoijebor/dev/commando merge feat-webpane-drag`, then worktree/branch cleanup) happens only after the user confirms the interaction feels right — the drop preview over native SwiftTerm surfaces is the one thing unit tests cannot prove.

---

## Self-Review Notes

- Spec coverage: drag interaction (Tasks 4-6), daemon move service (Task 1), move API incl. same-window 400 + auth + rate limit (Task 2), client move API (Task 3), occluder preview (Task 6 step 3.6/3.8); URL editing service/API/client (Tasks 7-9, incl. trust-policy pend + chromium engine sync via `onConfirmed`); maximize (Task 10); testing incl. e2e (each task + Task 11). Placement-flip-on-own-anchor needs no special code: moving to the same anchor with a new placement is an ordinary move.
- Terminal swap path is preserved by the `kind === 'terminal'` branch in `dropPane` and guarded by the Task 6 regression test; terminal maximize is preserved by the `isWebPaneLeafId` discrimination in Task 10.
- Type consistency: `move(webPaneId, anchor, placement)` / `navigate(webPaneId, url)` names match across service (Tasks 1, 7), API routes (Tasks 2, 8), and client (Tasks 3, 9). `DraggedItem`/`dropPlacementFor` (Task 4) match their uses in Task 6.
- Tasks 6 and 10's App.test.tsx steps intentionally direct the implementer to the file's existing fixtures/stubs rather than inventing parallel ones — the assertions to make are specified exactly.
