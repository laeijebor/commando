import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, WebPane } from '../shared/protocol.js'
import { GuideStateStore, Guides, guidePushPrompt } from './guides.js'
import { parseWebPaneContent } from './web-panes.js'

const GUIDE = '# Rollout\n\n- [ ] Copy the secret {#copy}\n- [x] Store it\n\n<checkpoint id="phase-1">Phase 1 done</checkpoint>\n\n- [ ] Merge #527\n'

describe('Guides', () => {
  let dir: string
  let status: AgentStatus | undefined
  let sendTerminal: ReturnType<typeof vi.fn<(paneId: string, text: string) => Promise<void>>>
  let changed: ReturnType<typeof vi.fn<(artifactId: string, file: string) => void>>
  let guides: Guides
  const pane = { id: 'w-00000001', anchorPaneId: '%5', content: { kind: 'guide', artifactId: '0123456789abcdef', file: 'guide.md' } } as WebPane

  const make = () => new Guides({
    repoRoot: '/repo',
    store: new GuideStateStore(join(dir, 'state.json')),
    pane: (id) => id === pane.id ? pane : undefined,
    resolveFile: (_artifact, file) => join(dir, file),
    changed,
    owns: () => false,
    sendChat: () => false,
    status: () => status,
    sendTerminal,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guides-'))
    writeFileSync(join(dir, 'guide.md'), GUIDE)
    status = { paneId: '%5', provider: 'claude', status: 'done' } as AgentStatus
    sendTerminal = vi.fn(async () => {})
    changed = vi.fn()
    guides = make()
  })

  it('reads steps from the guide file with the agent\'s [x] as the default state', () => {
    const snapshot = guides.snapshot(pane.id)
    expect(snapshot.title).toBe('Rollout')
    expect(snapshot.steps.map((step) => [step.id, step.checked])).toEqual([['copy', false], ['store-it', true], ['phase-1', false], ['merge-527', false]])
    expect(snapshot.changes).toEqual([])
  })

  it('persists ticks and notes and broadcasts the change', () => {
    guides.mark(pane.id, { id: 'copy', checked: true })
    const snapshot = guides.mark(pane.id, { id: 'copy', note: '  printed DIFFERENT ' })
    expect(snapshot.steps[0]).toMatchObject({ checked: true, note: 'printed DIFFERENT', byUser: true })
    expect(changed).toHaveBeenCalledWith('0123456789abcdef', 'guide.md')
    expect(make().snapshot(pane.id).steps[0]).toMatchObject({ checked: true, note: 'printed DIFFERENT' })
  })

  it('rejects unknown steps and malformed bodies', () => {
    expect(() => guides.mark(pane.id, { id: 'nope', checked: true })).toThrow('Step does not exist')
    expect(() => guides.mark(pane.id, { id: 'copy' })).toThrow('checked or note is required')
    expect(() => guides.mark(pane.id, { id: 'copy', checked: 'yes' })).toThrow('checked must be a boolean')
  })

  it('pushes the changes when the agent is idle and then advances the baseline', async () => {
    guides.mark(pane.id, { id: 'copy', checked: true })
    guides.mark(pane.id, { id: 'phase-1', checked: true })
    const snapshot = await guides.requestUpdate(pane.id)
    expect(sendTerminal).toHaveBeenCalledTimes(1)
    const [anchor, text] = sendTerminal.mock.calls[0]
    expect(anchor).toBe('%5')
    expect(text).toContain('Progress 3/4 · next open step: "Merge #527"')
    expect(text).toContain('- ✓ done: Copy the secret')
    expect(text).toContain('- ★ reached: Phase 1 done')
    expect(text).toContain('"/repo/scripts/commando-guide" state w-00000001')
    expect(snapshot).toMatchObject({ changes: [], waiting: false })
    await expect(guides.requestUpdate(pane.id)).rejects.toThrow('There are no changes to send')
  })

  it('waits for the agent to go idle and sends the latest state then', async () => {
    status = { paneId: '%5', provider: 'claude', status: 'working' } as AgentStatus
    guides.mark(pane.id, { id: 'copy', checked: true })
    expect(await guides.requestUpdate(pane.id)).toMatchObject({ waiting: true })
    guides.mark(pane.id, { id: 'merge-527', checked: true })
    expect(sendTerminal).not.toHaveBeenCalled()
    status = { paneId: '%5', provider: 'claude', status: 'done' } as AgentStatus
    await guides.statusChanged('%5')
    expect(sendTerminal.mock.calls[0][1]).toContain('Merge #527')
    expect(guides.snapshot(pane.id).waiting).toBe(false)
  })

  it('keeps the update owed when the paste fails', async () => {
    sendTerminal.mockRejectedValueOnce(new Error('Agent is unavailable'))
    guides.mark(pane.id, { id: 'copy', checked: true })
    expect(await guides.requestUpdate(pane.id)).toMatchObject({ waiting: true, changes: [{ id: 'copy' }] })
    await guides.statusChanged('%5')
    expect(guides.snapshot(pane.id)).toMatchObject({ waiting: false, changes: [] })
  })

  it('can cancel a waiting update and reset ticks', async () => {
    status = undefined
    guides.mark(pane.id, { id: 'store-it', checked: false })
    await guides.requestUpdate(pane.id)
    expect(guides.cancelUpdate(pane.id).waiting).toBe(false)
    expect(guides.reset(pane.id).steps[1]).toMatchObject({ checked: true, byUser: false })
  })

  it('reports an unreadable guide instead of throwing', () => {
    const missing = { ...pane, content: { ...pane.content!, file: 'gone.md' } } as WebPane
    const other = new Guides({ ...(guides as unknown as { deps: ConstructorParameters<typeof Guides>[0] }).deps, pane: () => missing })
    expect(other.snapshot(pane.id)).toMatchObject({ steps: [], error: expect.any(String) })
  })
})

describe('guidePushPrompt', () => {
  it('keeps the prompt to one paste-safe block', () => {
    const changes = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, label: `Step ${index}\nwith newline ${'x'.repeat(80)}`, checkpoint: false, checked: true, checkedChanged: true, noteChanged: false }))
    const text = guidePushPrompt('w-00000001', '/tmp/g.md', { title: 'T', steps: [], changes })
    expect(text.length).toBeLessThan(2_100)
    expect(text).toContain('more change(s)')
    expect(text.split('\n').every((line) => !line.includes('\r'))).toBe(true)
  })
})

describe('guide web pane content', () => {
  it('accepts a markdown file inside a registered artifact', () => {
    expect(parseWebPaneContent({ kind: 'guide', artifactId: '0123456789abcdef', file: './deploy.md' })).toEqual({ kind: 'guide', artifactId: '0123456789abcdef', file: 'deploy.md' })
    expect(parseWebPaneContent({ kind: 'guide', artifactId: '0123456789abcdef', file: '../deploy.md' })).toBeNull()
    expect(parseWebPaneContent({ kind: 'guide', artifactId: 'nope', file: 'deploy.md' })).toBeNull()
  })
})
