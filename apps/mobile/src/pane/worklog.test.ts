import { NOW, WORKLOG_BRIEF, WORKING_STATUS } from '../testing/fixtures'
import { parseInline, parseMarkdown } from './markdown'
import { buildWorklogView, hudDetailsView, planProgress, timelineEntries } from './worklog'

describe('the worklog view model', () => {
  it('leaves cancelled tasks out of the progress denominator', () => {
    const progress = planProgress(WORKLOG_BRIEF.tasks)
    // Eight tasks, one cancelled: four of the seven that count are done.
    expect(progress.tasks).toHaveLength(8)
    expect(progress.completed).toBe(4)
    expect(progress.total).toBe(7)
    expect(progress.ratio).toBeCloseTo(4 / 7)
  })

  it('reads as empty rather than dividing by zero without tasks', () => {
    expect(planProgress(undefined)).toEqual({ tasks: [], completed: 0, total: 0, ratio: 0 })
    expect(planProgress([
      { id: 'x', content: 'dropped', status: 'cancelled', priority: 'low' },
    ]).ratio).toBe(0)
  })

  it('orders the activity timeline newest first and names the author', () => {
    const timeline = timelineEntries(WORKLOG_BRIEF.updates)
    expect(timeline.map((entry) => entry.id)).toEqual(['u1', 'u2', 'u3'])
    expect(timeline[0]?.detail).toBe('server/companion.test.ts')
    expect(timeline[0]?.author).toBe('Lifecycle')
    expect(timeline[1]?.author).toBe('Agent update')
  })

  it('carries the headline, next action and screenshots through', () => {
    const view = buildWorklogView(WORKLOG_BRIEF)
    expect(view.headline).toBe('Add an owner-auth answer channel for the companion')
    expect(view.next).toBe('Wire answer_agent_request on /ws')
    expect(view.state).toBe('needs_input')
    expect(view.screenshots).toHaveLength(1)
    expect(view.updatedAt).toBe(NOW - 3 * 60 * 1000)
  })

  it('falls back to the HUD details when a pane has no brief', () => {
    const hud = hudDetailsView(WORKING_STATUS)
    expect(hud?.activity).toBe('✎ src/poll.ts')
    expect(hudDetailsView(undefined)).toBeNull()
  })
})

describe('the recap markdown reader', () => {
  it('splits paragraphs and bullets, and drops images', () => {
    const blocks = parseMarkdown(WORKLOG_BRIEF.recapMarkdown)
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'bullet', 'bullet'])
    expect(blocks[2]?.spans.map((span) => span.text).join('')).toBe(' dropped by the renderer')
  })

  it('marks inline code and bold spans', () => {
    const spans = parseInline('Reusing `buildCompanionSnapshot` keeps **one** shape')
    expect(spans[1]).toEqual({ text: 'buildCompanionSnapshot', code: true })
    expect(spans.find((span) => span.bold)).toEqual({ text: 'one', bold: true })
  })

  it('keeps link text and understands headings and ordered lists', () => {
    expect(parseMarkdown('## Recap\n1. First step\n[the spec](docs/spec.md) matters')).toEqual([
      { kind: 'heading', level: 2, spans: [{ text: 'Recap' }] },
      { kind: 'bullet', ordinal: '1.', spans: [{ text: 'First step' }] },
      { kind: 'paragraph', spans: [{ text: 'the spec matters' }] },
    ])
  })
})
