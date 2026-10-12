import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus, WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'
import { CanvasPush, canvasPushPrompt, canvasRepoRoot } from './canvas-push.js'

const id = 'w-12345678'
const note = (key = 'one'): WebPaneFeedbackNote => ({ deliveryKey: key, comment: 'Fix this\nrow', selector: '#row', tag: 'button', rect: { x: 0, y: 0, width: 1, height: 1 }, pageUrl: 'http://localhost/', capturedAt: 1,
  canvas: { frameId: 'settings', frameTitle: 'Settings', label: 'Row', threadId: 'ct-' + 'a'.repeat(24), point: { x: 0, y: 0 } } })
function fixture(chat = false, initial: AgentStatus['status'] = 'done') {
  let status = { paneId: '%1', provider: 'claude', status: initial } as AgentStatus
  const pane = vi.fn(() => ({ id, anchorPaneId: '%1', content: { kind: 'canvas' } }) as WebPane)
  const sendChat = vi.fn(() => true), sendTerminal = vi.fn(async (_paneId: string, _text: string) => {}), owns = vi.fn(() => chat)
  const push = new CanvasPush({ pane, title: () => 'Board', owns, sendChat, sendTerminal, status: () => status })
  return { push, sendChat, sendTerminal, pane, owns, status: (next: Partial<AgentStatus>) => { status = { ...status, ...next } } }
}
describe('CanvasPush (injected senders only)', () => {
  it('queues through hub.send even while a chat turn is working, and never duplicates a delivery', async () => {
    const f = fixture(true, 'working')
    await f.push.deliver(id, [note()]); await f.push.deliver(id, [note()]); await f.push.statusChanged('%1')
    expect(f.sendChat).toHaveBeenCalledExactlyOnceWith('%1', canvasPushPrompt('Board', id, [note()]), expect.stringMatching(/^canvas-/))
    expect(f.sendTerminal).not.toHaveBeenCalled()
  })
  it('sends to a done terminal with one literal prompt and remembers it', async () => {
    const f = fixture()
    await f.push.deliver(id, [note(), note('two')])
    await f.push.deliver(id, [note(), note('two')])
    expect(f.sendTerminal).toHaveBeenCalledExactlyOnceWith('%1', canvasPushPrompt('Board', id, [note(), note('two')]))
    expect(f.sendChat).not.toHaveBeenCalled()
  })
  it.each(['working', 'needs_input', 'failed', 'stale', 'unknown'] as const)('owes %s terminals until done and pushes once', async (status) => {
    const f = fixture(false, status)
    await f.push.deliver(id, [note()]); await f.push.deliver(id, [note('two')])
    await f.push.statusChanged('%1')
    expect(f.sendTerminal).not.toHaveBeenCalled()
    f.status({ status: 'done' })
    await f.push.statusChanged('%2')
    expect(f.sendTerminal).not.toHaveBeenCalled()
    await f.push.statusChanged('%1'); await f.push.statusChanged('%1')
    expect(f.sendTerminal).toHaveBeenCalledTimes(1)
    expect(f.sendTerminal.mock.calls[0][1]).toContain('(2 comment(s))')
  })
  it('does not type into unknown providers and clears closed tabs', async () => {
    const f = fixture(); f.status({ provider: 'unknown' })
    await f.push.deliver(id, [note()]); expect(f.sendTerminal).not.toHaveBeenCalled()
    f.push.retain(new Set()); f.status({ provider: 'codex' })
    await f.push.statusChanged('%1'); expect(f.sendTerminal).not.toHaveBeenCalled()
  })
  it('keeps failed sends owed and prevents overlapping sends of the same delivery', async () => {
    const f = fixture()
    f.sendTerminal.mockRejectedValueOnce(new Error('unavailable'))
    await f.push.deliver(id, [note()])
    let finish!: () => void
    f.sendTerminal.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const sending = f.push.statusChanged('%1')
    await f.push.deliver(id, [note()]); await f.push.statusChanged('%1')
    expect(f.sendTerminal).toHaveBeenCalledTimes(2)
    finish(); await sending; await f.push.statusChanged('%1')
    expect(f.sendTerminal).toHaveBeenCalledTimes(2)
  })
  it('keeps a missing agent status owed, then sends when a known provider finishes', async () => {
    let status: AgentStatus | undefined
    const sendTerminal = vi.fn(async (_paneId: string, _text: string) => {})
    const push = new CanvasPush({ pane: () => ({ id, anchorPaneId: '%1', content: { kind: 'canvas' } }) as WebPane,
      title: () => 'Board', owns: () => false, sendChat: vi.fn(), status: () => status, sendTerminal })
    await push.deliver(id, [note()]); await push.statusChanged('%1')
    expect(sendTerminal).not.toHaveBeenCalled()
    status = { paneId: '%1', provider: 'codex', status: 'done' } as AgentStatus
    await push.statusChanged('%1'); await push.statusChanged('%1')
    expect(sendTerminal).toHaveBeenCalledTimes(1)
  })
  it('does not mark a disconnected chat host as delivered', async () => {
    const f = fixture(true); f.sendChat.mockReturnValueOnce(false)
    await f.push.deliver(id, [note()]); await f.push.statusChanged('%1'); await f.push.statusChanged('%1')
    expect(f.sendChat).toHaveBeenCalledTimes(2)
    expect(f.sendTerminal).not.toHaveBeenCalled()
  })
  it('formats the collection/reply instructions, unlabelled notes and bounded truncation', () => {
    const prompt = canvasPushPrompt('Board', id, [note()])
    expect(prompt).toBe(`Canvas feedback on "Board" (1 comment(s)) — webPaneId ${id}.\n- [Settings › Row] Fix this row  (thread ct-${'a'.repeat(24)})\nRun "${canvasRepoRoot}scripts/commando-feedback" ${id} to collect them (this also acknowledges them), apply the changes, and reply in each thread with "${canvasRepoRoot}scripts/commando-canvas" reply ${id} <threadId> "<text>" [--resolve].`)
    expect(canvasPushPrompt('Board', id, [{ ...note(), canvas: { ...note().canvas!, label: undefined } }])).toContain('› unlabelled]')
    const many = Array.from({ length: 200 }, (_, i) => ({ ...note(String(i)), comment: 'x'.repeat(4096), canvas: { ...note().canvas!, frameTitle: 't'.repeat(1024), label: 'l'.repeat(256) } }))
    const long = canvasPushPrompt('t'.repeat(1024), id, many)
    expect(long.length).toBeLessThanOrEqual(2000)
    expect(long).toContain('…'); expect(long).toMatch(/\d+ comment\(s\) omitted/)
    expect(long).toContain('scripts/commando-feedback'); expect(long).toContain('[--resolve]')
  })
})

it('uses injected absolute checkout paths and removes every C0/C1 control from interpolated fields', () => {
  const attack = '\u001b[201~\u0003' + Array.from({ length: 160 }, (_, i) => String.fromCharCode(i)).join('')
  const n = note(); n.comment = attack; n.canvas = { ...n.canvas!, frameTitle: attack, label: attack, threadId: attack }
  const prompt = canvasPushPrompt(attack, attack, [n], '/tmp/other checkout')
  expect(prompt).toContain('"/tmp/other checkout/scripts/commando-feedback"')
  expect(prompt).toContain('"/tmp/other checkout/scripts/commando-canvas"')
  expect(prompt).not.toContain('\u001b[201~\u0003')
  expect(prompt.replaceAll('\n', '')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
})
it('serializes two canvases at one anchor and rechecks availability before the second paste', async () => {
  const f = fixture()
  let finish!: () => void
  f.sendTerminal.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const first = f.push.deliver(id, [note()])
  await f.push.deliver('w-87654321', [note('two')])
  expect(f.sendTerminal).toHaveBeenCalledTimes(1)
  f.status({ status: 'working' }); finish(); await first
  expect(f.sendTerminal).toHaveBeenCalledTimes(1)
  f.status({ status: 'done' }); await f.push.statusChanged('%1')
  expect(f.sendTerminal).toHaveBeenCalledTimes(2)
})
it('drops acknowledged owed feedback before done', async () => {
  const f = fixture(false, 'working')
  await f.push.deliver(id, [note()]); f.push.acknowledge(id, ['one'])
  f.status({ status: 'done' }); await f.push.statusChanged('%1')
  expect(f.sendTerminal).not.toHaveBeenCalled()
})
it('keeps only the last 2000 pushed delivery keys', async () => {
  const f = fixture(true)
  await f.push.deliver(id, Array.from({ length: 2001 }, (_, i) => note(String(i))))
  await f.push.deliver(id, [note('2000')]); expect(f.sendChat).toHaveBeenCalledTimes(1)
  await f.push.deliver(id, [note('0')]); expect(f.sendChat).toHaveBeenCalledTimes(2)
})
