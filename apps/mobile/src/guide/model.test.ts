import {
  buildGuideDocument,
  cleanInlineHtml,
  deliveryLabel,
  guideEventScope,
  guideFilePath,
  guideProgress,
  matchSteps,
  outlineGuide,
  stripStepId,
  withOptimisticTick,
  type GuideBlock,
  type GuideSnapshot,
} from './model'
import { GUIDE } from './fixtures'

/** The daemon's parse of GUIDE (shared/guide.ts parseGuide), as the snapshot carries it. */
const STEPS = [
  { id: 'copy-platform', label: 'Stripe → Live mode → graphql → copy', checkpoint: false },
  { id: 'store-platform', label: 'Store the platform secret in Doppler:', checkpoint: false },
  { id: 'railway-sync-is-configured-i-checked', label: 'Railway sync is configured (I checked)', checkpoint: false },
  { id: 'phase-1', label: 'Phase 1 done — both secrets match', checkpoint: true },
  { id: 'inline-reached', label: 'Inline reached', checkpoint: true },
]

function collect(blocks: readonly GuideBlock[], into: GuideBlock[] = []): GuideBlock[] {
  for (const block of blocks) {
    into.push(block)
    if (block.kind === 'list') for (const item of block.items) collect(item.body, into)
    if (block.kind === 'callout' || block.kind === 'details' || block.kind === 'quote') collect(block.body, into)
  }
  return into
}

describe('buildGuideDocument', () => {
  const document = buildGuideDocument(GUIDE, STEPS)
  const all = collect(document.blocks)
  const tasks = all.flatMap((block) => block.kind === 'list' ? block.items.filter((item) => item.task) : [])

  it('ties every task item and checkpoint to the daemon step id, in document order', () => {
    expect(tasks.map((item) => item.stepId)).toEqual(['copy-platform', 'store-platform', 'railway-sync-is-configured-i-checked'])
    expect(tasks.map((item) => item.sourceChecked)).toEqual([false, false, true])
    expect(all.filter((block) => block.kind === 'checkpoint').map((block) => block.kind === 'checkpoint' && [block.stepId, block.sourceChecked])).toEqual([['phase-1', false], ['inline-reached', true]])
  })

  it('hides `{#id}` suffixes and keeps a step’s code block inside the step', () => {
    const store = tasks[1]!
    expect(store.body[0]).toMatchObject({ kind: 'markdown', text: 'Store the platform secret in Doppler:' })
    expect(store.body[1]).toMatchObject({ kind: 'code', lang: 'sh', code: 'pbpaste | doppler secrets set X' })
    expect(JSON.stringify(document.blocks)).not.toContain('{#')
  })

  it('reads callouts and details around the blocks between their tags', () => {
    const callout = all.find((block) => block.kind === 'callout')
    expect(callout).toMatchObject({ tone: 'warn', title: 'Before you merge #527', body: [{ kind: 'markdown', text: 'These keep **live** billing working.' }] })
    expect(all.find((block) => block.kind === 'details')).toMatchObject({ summary: 'Why', body: [{ kind: 'markdown', text: 'Because.' }] })
  })

  it('splits prose around an inline checkpoint and makes <kbd> read as code', () => {
    const index = all.findIndex((block) => block.kind === 'checkpoint' && block.stepId === 'inline-reached')
    expect(all[index - 1]).toMatchObject({ kind: 'markdown', text: 'Press `Cmd` then' })
    expect(all[index + 1]).toMatchObject({ kind: 'markdown', text: 'to finish.' })
  })

  it('leaves a step it cannot match unticked-able rather than guessing a foreign id', () => {
    const lone = buildGuideDocument('- [ ] Only step\n', [])
    const list = lone.blocks[0]
    expect(list).toMatchObject({ kind: 'list', items: [{ task: true }] })
    expect(list?.kind === 'list' && list.items[0]!.stepId).toBeUndefined()
  })

  it('renders a list without steps as plain Markdown', () => {
    expect(buildGuideDocument('- one\n- two\n', []).blocks).toEqual([{ kind: 'markdown', key: 'g.0', text: '- one\n- two' }])
  })
})

describe('matchSteps', () => {
  const steps = [
    { id: 'a', label: 'First', checkpoint: false },
    { id: 'b', label: 'Second', checkpoint: false },
    { id: 'cp', label: 'Done', checkpoint: true },
  ]
  it('prefers explicit ids, then labels, then position within the kind', () => {
    expect(matchSteps([
      { checkpoint: false, label: 'Second', sourceChecked: false },
      { checkpoint: true, label: 'Reworded', sourceChecked: false },
      { checkpoint: false, label: 'Reworded first', explicitId: 'a', sourceChecked: false },
    ], steps)).toEqual(['b', 'cp', 'a'])
  })
  it('never hands one id to two steps', () => {
    expect(matchSteps([
      { checkpoint: false, label: 'First', sourceChecked: false },
      { checkpoint: false, label: 'First', sourceChecked: false },
      { checkpoint: false, label: 'First', sourceChecked: false },
    ], steps)).toEqual(['a', 'b', undefined])
  })
})

describe('outlineGuide', () => {
  it('derives the title and ids the way shared/guide.ts does for explicit and slugged steps', () => {
    expect(outlineGuide(GUIDE)).toEqual({
      title: 'Stripe webhook rollout',
      steps: [
        { id: 'copy-platform', label: 'Stripe → Live mode → graphql → copy', checkpoint: false, sourceChecked: false },
        { id: 'store-platform', label: 'Store the platform secret in Doppler:', checkpoint: false, sourceChecked: false },
        { id: 'railway-sync-is-configured-i-checked', label: 'Railway sync is configured (I checked)', checkpoint: false, sourceChecked: true },
        { id: 'phase-1', label: 'Phase 1 done — both secrets match', checkpoint: true, sourceChecked: false },
        { id: 'inline-reached', label: 'Inline reached', checkpoint: true, sourceChecked: true },
      ],
    })
  })
})

describe('helpers', () => {
  const snapshot: GuideSnapshot = {
    title: 'T',
    steps: [
      { id: 'a', label: 'A', checkpoint: false, sourceChecked: false, offset: 0, checked: false, byUser: false },
      { id: 'b', label: 'B', checkpoint: false, sourceChecked: true, offset: 10, checked: true, byUser: false },
    ],
    marks: {},
    changes: [],
    waiting: false,
  }

  it('counts progress', () => {
    expect(guideProgress(snapshot.steps)).toEqual({ done: 1, total: 2, fraction: 0.5 })
    expect(guideProgress([])).toEqual({ done: 0, total: 0, fraction: 0 })
  })

  it('ticks optimistically without touching other steps', () => {
    const next = withOptimisticTick(snapshot, 'a', true, 5)
    expect(next.steps.map((step) => [step.id, step.checked, step.byUser])).toEqual([['a', true, true], ['b', true, false]])
    expect(next.marks).toEqual({ a: { checked: true, at: 5 } })
    expect(snapshot.steps[0]!.checked).toBe(false)
  })

  it('words delivery as the desktop does', () => {
    const now = 1_000_000_000
    expect(deliveryLabel(null, now)).toBe('')
    expect(deliveryLabel({ ...snapshot, waiting: true }, now)).toBe('Sends when the agent is idle…')
    expect(deliveryLabel({ ...snapshot, changes: [{ id: 'a', label: 'A', checkpoint: false, checked: true, checkedChanged: true, noteChanged: false }] }, now)).toBe('1 unsent change')
    expect(deliveryLabel({ ...snapshot, deliveredAt: now - 5 * 60_000 }, now)).toBe('Agent updated 5m ago')
  })

  it('scopes socket events to this guide', () => {
    const content = { artifactId: '0123456789abcdef', file: 'guides/run.md' }
    expect(guideEventScope({ type: 'canvas_changed', artifactId: content.artifactId, changed: ['guides/run.md'] }, content)).toBe('all')
    expect(guideEventScope({ type: 'canvas_changed', artifactId: content.artifactId, changed: ['*'] }, content)).toBe('all')
    expect(guideEventScope({ type: 'canvas_changed', artifactId: content.artifactId, changed: ['other.md'] }, content)).toBeNull()
    expect(guideEventScope({ type: 'guide_state_changed', ...content }, content)).toBe('state')
    expect(guideEventScope({ type: 'guide_state_changed', artifactId: 'ffffffffffffffff', file: content.file }, content)).toBeNull()
  })

  it('builds the artifact path the daemon serves', () => {
    expect(guideFilePath({ artifactId: '0123456789abcdef', file: 'a b/run.md' })).toBe('/redline/artifacts/0123456789abcdef/a%20b/run.md')
  })

  it('strips ids and inline HTML outside code spans only', () => {
    expect(stripStepId('Copy it {#copy-it}\n')).toBe('Copy it')
    expect(cleanInlineHtml('Hit <kbd>Esc</kbd>, keep `<kbd>x</kbd>`')).toBe('Hit `Esc`, keep `<kbd>x</kbd>`')
  })
})
