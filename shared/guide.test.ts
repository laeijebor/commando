import { describe, expect, it } from 'vitest'
import { guideRelativePath, guideSnapshot, parseGuide } from './guide.js'

const GUIDE = `# Stripe rollout

## Phase 1

1. **Get the secret.**
   - [ ] Reveal and copy the signing secret {#reveal}
   - [x] Store it in \`Doppler\`
   - [ ] Check Railway

<checkpoint id="phase-1">Phase 1 done</checkpoint>

\`\`\`sh
- [ ] not a step inside code
<checkpoint id="nope">no</checkpoint>
\`\`\`

- [ ] Check Railway
`

describe('parseGuide', () => {
  it('reads the title, task items and checkpoints in document order', () => {
    const { title, steps } = parseGuide(GUIDE)
    expect(title).toBe('Stripe rollout')
    expect(steps.map(({ id, label, checkpoint, sourceChecked }) => ({ id, label, checkpoint, sourceChecked }))).toEqual([
      { id: 'reveal', label: 'Reveal and copy the signing secret', checkpoint: false, sourceChecked: false },
      { id: 'store-it-in-doppler', label: 'Store it in Doppler', checkpoint: false, sourceChecked: true },
      { id: 'check-railway', label: 'Check Railway', checkpoint: false, sourceChecked: false },
      { id: 'phase-1', label: 'Phase 1 done', checkpoint: true, sourceChecked: false },
      { id: 'check-railway-2', label: 'Check Railway', checkpoint: false, sourceChecked: false },
    ])
  })

  it('records source offsets that point at each item', () => {
    const { steps } = parseGuide(GUIDE)
    expect(GUIDE.slice(steps[0].offset)).toMatch(/^- \[ \] Reveal/)
    expect(GUIDE.slice(steps[3].offset)).toMatch(/^<checkpoint/)
  })

  it('parses block checkpoints and the done attribute', () => {
    const { steps } = parseGuide('<checkpoint id="ship" done>\nShipped it\n</checkpoint>\n')
    expect(steps).toMatchObject([{ id: 'ship', label: 'Shipped it', checkpoint: true, sourceChecked: true }])
  })

  it('finds every checkpoint in an HTML block and ids the ones without a usable id', () => {
    const { steps } = parseGuide('<div>\n<checkpoint>Reach phase one</checkpoint>\n<checkpoint id="dup">First</checkpoint>\n<checkpoint id="dup">Second</checkpoint>\n</div>\n')
    expect(steps.map((step) => [step.id, step.label])).toEqual([['reach-phase-one', 'Reach phase one'], ['dup', 'First'], ['second', 'Second']])
  })

  it('keeps ids stable when unrelated steps are added', () => {
    const before = parseGuide('- [ ] One\n- [ ] Two\n').steps.map((step) => step.id)
    const after = parseGuide('- [ ] Zero\n- [ ] One\n- [ ] Two\n').steps.map((step) => step.id)
    expect(after.slice(1)).toEqual(before)
  })
})

describe('guideSnapshot', () => {
  const outline = parseGuide('- [ ] One\n- [x] Two\n- [ ] Three\n')

  it('lets user marks win over the source and lists only undelivered changes', () => {
    const snapshot = guideSnapshot(outline, {
      one: { checked: true, at: 1 },
      two: { checked: false, at: 2 },
      three: { checked: false, note: 'blocked on access', at: 3 },
    }, { one: { checked: true } })
    expect(snapshot.steps.map((step) => [step.id, step.checked, step.byUser])).toEqual([['one', true, true], ['two', false, true], ['three', false, true]])
    expect(snapshot.changes).toEqual([
      { id: 'two', label: 'Two', checkpoint: false, checked: false, checkedChanged: true, noteChanged: false },
      { id: 'three', label: 'Three', checkpoint: false, checked: false, note: 'blocked on access', checkedChanged: false, noteChanged: true },
    ])
  })

  it('lets a note-only mark keep following the source tick', () => {
    const snapshot = guideSnapshot(outline, { two: { note: 'checked by hand', at: 1 } }, {})
    expect(snapshot.steps[1]).toMatchObject({ checked: true, byUser: false, note: 'checked by hand' })
    expect(snapshot.changes).toEqual([{ id: 'two', label: 'Two', checkpoint: false, checked: true, note: 'checked by hand', checkedChanged: false, noteChanged: true }])
  })

  it('ignores marks for steps the agent removed', () => {
    expect(guideSnapshot(outline, { gone: { checked: true, at: 1 } }, {}).changes).toEqual([])
  })
})

describe('guideRelativePath', () => {
  it('accepts markdown paths inside the artifact folder only', () => {
    expect(guideRelativePath('./guides/deploy.md')).toBe('guides/deploy.md')
    expect(guideRelativePath('deploy.html')).toBeNull()
    expect(guideRelativePath('../deploy.md')).toBeNull()
    expect(guideRelativePath('/tmp/deploy.md')).toBeNull()
  })
})
