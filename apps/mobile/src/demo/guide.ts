import type { ServerMessage } from '@commando/protocol'
import type { GuideDelivered, GuideMark } from '@commando/guide-types'

import { guideApiPath, guideFilePath, outlineGuide, type GuideSnapshot } from '../guide/model'

/**
 * The demo host's one guide tab. The daemon's guide state machine is played
 * locally: ticks and notes become marks, "Update agent" advances the delivered
 * baseline, and the pretend agent answers by editing the file, which reaches
 * the open tab as a `canvas_changed` event exactly as a real edit would.
 */
export const DEMO_GUIDE = { id: 'demo-guide', artifactId: '0123456789abcdef', file: 'review.md' } as const

const INITIAL = `# Review the companion on a phone

The pane tabs and the remote chat are ready. Walk through them on the simulator
and tick each step as you go — add a note wherever something looks off.

## Phase 1: chat

- [x] Metro is running on port 8094 (I started it) {#metro}
- [ ] Open **Remote chat** from the Chats list {#open-chat}
- [ ] Send a short message and watch the reply stream in {#send-message}

  \`\`\`sh
  npm run mobile:start -- --port 8094
  \`\`\`

<checkpoint id="chat-ok">The chat reads like the desktop</checkpoint>

## Phase 2: pane tabs

<callout tone="warn" title="Keep the keyboard in mind">

Open the keyboard once on each tab. Nothing should hide behind it.

</callout>

- [ ] Swipe through Worklog, Changes and the PR tab {#tabs}
- [ ] Open the **Companion preview** tile and come back {#tile}
- [ ] Rotate to landscape and back {#rotate}

<checkpoint id="tabs-ok">Pane tabs feel native</checkpoint>
`

const REPLY = `

<callout tone="success" title="Thanks — I read your update">

I checked the chat on my side too. Next I'll tidy the tab spacing you noted.

</callout>
`

type DemoGuideState = { markdown: string; marks: Record<string, GuideMark>; delivered: Record<string, GuideDelivered>; deliveredAt?: number; replied: boolean }
let state: DemoGuideState = fresh()
function fresh(): DemoGuideState { return { markdown: INITIAL, marks: {}, delivered: {}, replied: false } }

/** For tests: forget every tick, note and delivery. */
export function resetDemoGuide(): void { state = fresh() }

/** The daemon's guideSnapshot (shared/guide.ts) over the demo's own outline. */
export function demoGuideSnapshot(): GuideSnapshot {
  const outline = outlineGuide(state.markdown)
  const steps = outline.steps.map((step, offset) => {
    const mark = state.marks[step.id]
    return { ...step, offset, checked: mark?.checked ?? step.sourceChecked, ...(mark?.note ? { note: mark.note } : {}), byUser: mark?.checked !== undefined }
  })
  const changes: GuideSnapshot['changes'] = []
  for (const step of steps) {
    if (!state.marks[step.id]) continue
    const baseline = state.delivered[step.id] ?? {}
    const checkedChanged = step.byUser && step.checked !== (baseline.checked ?? step.sourceChecked)
    const noteChanged = (step.note ?? '') !== (baseline.note ?? '')
    if (checkedChanged || noteChanged) changes.push({ id: step.id, label: step.label, checkpoint: step.checkpoint, checked: step.checked, ...(step.note ? { note: step.note } : {}), checkedChanged, noteChanged })
  }
  return { title: outline.title, steps, changes, marks: state.marks, waiting: false, ...(state.deliveredAt ? { deliveredAt: state.deliveredAt } : {}) }
}

type Reply = { status: number; body?: unknown; text?: string; events?: ServerMessage[]; later?: { delayMs: number; events: () => ServerMessage[] } }
const changed = (): ServerMessage => ({ type: 'guide_state_changed', artifactId: DEMO_GUIDE.artifactId, file: DEMO_GUIDE.file })
const ok = (events: ServerMessage[] = [changed()], later?: Reply['later']): Reply => ({ status: 200, body: { ok: true, webPaneId: DEMO_GUIDE.id, guide: demoGuideSnapshot() }, events, ...(later ? { later } : {}) })
const fail = (status: number, error: string): Reply => ({ status, body: { error } })

/** Answers the guide's routes, or null when the path is not the demo guide's. */
export function demoGuideRoute(pathname: string, method: string, body: unknown): Reply | null {
  if (pathname === guideFilePath(DEMO_GUIDE)) return { status: 200, text: state.markdown }
  if (!pathname.startsWith(guideApiPath(DEMO_GUIDE.id))) return null
  const action = pathname.slice(guideApiPath(DEMO_GUIDE.id).length)
  if (action === '' && method === 'GET') return ok([])
  if (action === '/steps' && method === 'POST') {
    const { id, checked, note } = (body ?? {}) as { id?: unknown; checked?: unknown; note?: unknown }
    if (typeof id !== 'string' || !demoGuideSnapshot().steps.some((step) => step.id === id)) return fail(404, 'Step does not exist')
    if (checked === undefined && note === undefined) return fail(400, 'checked or note is required')
    const previous = state.marks[id]
    const nextChecked = typeof checked === 'boolean' ? checked : previous?.checked
    const nextNote = typeof note === 'string' ? note.trim() : previous?.note
    const marks = { ...state.marks }
    if (nextChecked === undefined && !nextNote) delete marks[id]
    else marks[id] = { ...(nextChecked !== undefined ? { checked: nextChecked } : {}), ...(nextNote ? { note: nextNote } : {}), at: Date.now() }
    state = { ...state, marks }
    return ok()
  }
  if (action === '/reset' && method === 'POST') { state = { ...state, marks: {} }; return ok() }
  if (action === '/update' && method === 'DELETE') return ok()
  if (action === '/update' && method === 'POST') {
    const snapshot = demoGuideSnapshot()
    if (!snapshot.changes.length) return fail(409, 'There are no changes to send')
    // The demo agent is always idle, so the update is delivered at once.
    const delivered = { ...state.delivered }
    for (const change of snapshot.changes) {
      const told = delivered[change.id] ?? {}
      delivered[change.id] = { ...(change.checkedChanged ? { checked: change.checked } : told.checked !== undefined ? { checked: told.checked } : {}), ...(change.note ? { note: change.note } : {}) }
    }
    state = { ...state, delivered, deliveredAt: Date.now() }
    const reply = state.replied ? undefined : {
      delayMs: 1_500,
      events: (): ServerMessage[] => {
        // The agent answers in the file: it confirms the chat checkpoint and adds a callout.
        state = { ...state, replied: true, markdown: state.markdown.replace('<checkpoint id="chat-ok">', '<checkpoint id="chat-ok" done>').replace('\n## Phase 2', `${REPLY}\n## Phase 2`) }
        return [{ type: 'canvas_changed', artifactId: DEMO_GUIDE.artifactId, changed: [DEMO_GUIDE.file] }]
      },
    }
    return ok([changed()], reply)
  }
  return fail(405, 'Method not allowed')
}
