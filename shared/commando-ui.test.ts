import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMANDO_UI_LIMITS, formatApproveAnswer, formatChoiceAnswer, matchBlockAnswer, parseCommandoUi, settledAnswer, type CommandoUiBlock } from './commando-ui.js'

const parse = (value: unknown) => parseCommandoUi(typeof value === 'string' ? value : JSON.stringify(value))
const reason = (value: unknown) => {
  const result = parse(value)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.reason
}

describe('commando-ui catalog', () => {
  it('parses one block of each component with defaults applied', () => {
    const result = parse([
      { component: 'choice', id: 'a', prompt: 'Pick', options: ['x', 'y'] },
      { component: 'approve', prompt: 'Ship?' },
      { component: 'checklist', items: [{ label: 'one' }, { label: 'two', done: true }] },
      { component: 'table', columns: ['a', 'b'], rows: [['x', 1]] },
      { component: 'stats', items: [{ label: 'Tests', value: 12, delta: '+2', tone: 'good' }, { label: 'Time', value: '3s' }] },
    ])
    expect(result).toEqual({ ok: true, blocks: [
      { component: 'choice', id: 'a', prompt: 'Pick', options: ['x', 'y'], multiple: false },
      { component: 'approve', prompt: 'Ship?', approveLabel: 'Approve', rejectLabel: 'Reject' },
      { component: 'checklist', items: [{ label: 'one', done: false }, { label: 'two', done: true }] },
      { component: 'table', columns: ['a', 'b'], rows: [['x', 1]], truncatedRows: 0 },
      { component: 'stats', items: [{ label: 'Tests', value: '12', delta: '+2', tone: 'good' }, { label: 'Time', value: '3s', tone: 'neutral' }] },
    ] })
  })

  it('accepts a single object and drops unknown keys', () => {
    const result = parse({ component: 'approve', prompt: 'Go?', onClick: 'alert(1)', approveLabel: 'Yes' })
    expect(result).toEqual({ ok: true, blocks: [{ component: 'approve', prompt: 'Go?', approveLabel: 'Yes', rejectLabel: 'Reject' }] })
  })

  it('rejects invalid shapes with a reason and never throws', () => {
    expect(reason({ component: 'carousel' })).toMatch(/unknown component "carousel"/)
    expect(reason({ prompt: 'x' })).toMatch(/no component/)
    expect(reason('"text"')).toMatch(/must be an object/)
    expect(reason(null)).toMatch(/must be an object/)
    expect(reason([])).toMatch(/1 to 8 blocks/)
    expect(reason(Array.from({ length: 9 }, () => ({ component: 'approve', prompt: 'x' })))).toMatch(/1 to 8 blocks/)
    expect(reason({ component: 'choice', prompt: 'p', options: ['one'] })).toMatch(/2 to 8/)
    expect(reason({ component: 'choice', prompt: 'p', options: Array.from({ length: 9 }, (_, i) => `o${i}`) })).toMatch(/2 to 8/)
    expect(reason({ component: 'choice', prompt: 'p', options: ['a', 'a'] })).toMatch(/different/)
    expect(reason({ component: 'choice', prompt: 'p', options: ['a', 3] })).toMatch(/option 2/)
    expect(reason({ component: 'choice', prompt: '', options: ['a', 'b'] })).toMatch(/prompt/)
    expect(reason({ component: 'choice', prompt: 'p', options: ['a', 'b'], multiple: 'yes' })).toMatch(/multiple/)
    expect(reason({ component: 'checklist', items: [] })).toMatch(/items/)
    expect(reason({ component: 'checklist', items: ['x'] })).toMatch(/must be an object/)
    expect(reason({ component: 'table', columns: ['a'], rows: [['x', 'y']] })).toMatch(/row 1/)
    expect(reason({ component: 'table', columns: ['a'], rows: [[{}]] })).toMatch(/string or number/)
    expect(reason({ component: 'table', columns: ['a'], rows: [[Number.NaN]] })).toMatch(/string or number|valid JSON/)
    expect(reason({ component: 'stats', items: [{ label: 'a', value: 1, tone: 'loud' }] })).toMatch(/tone/)
    expect(reason({ component: 'stats', items: [{ label: 'a' }] })).toMatch(/value/)
    expect(reason({ component: 'approve', prompt: 'p', id: 5 })).toMatch(/id/)
  })

  it('caps text lengths', () => {
    const long = 'x'.repeat(COMMANDO_UI_LIMITS.prompt + 1)
    expect(reason({ component: 'approve', prompt: long })).toMatch(/longer than/)
    expect(reason({ component: 'choice', prompt: 'p', options: ['a', 'x'.repeat(COMMANDO_UI_LIMITS.option + 1)] })).toMatch(/longer than/)
    expect(reason({ component: 'table', columns: ['a'], rows: [['x'.repeat(COMMANDO_UI_LIMITS.cell + 1)]] })).toMatch(/longer than/)
    expect(reason('{"component":"approve","prompt":"' + 'y'.repeat(COMMANDO_UI_LIMITS.source) + '"}')).toMatch(/too long/)
  })

  it('caps table rows and reports how many were left out', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [i])
    const result = parse({ component: 'table', columns: ['n'], rows })
    expect(result.ok && result.blocks[0]).toMatchObject({ truncatedRows: 10 })
    expect(result.ok && result.blocks[0]?.component === 'table' && result.blocks[0].rows).toHaveLength(50)
  })

  it('marks cut-off JSON as incomplete but wrong JSON as an error', () => {
    const partial = parseCommandoUi('{ "component": "choice", "prompt": "Pick", "options": ["a", ')
    expect(partial).toMatchObject({ ok: false, incomplete: true })
    expect(parseCommandoUi('{ "component": "choice", "prompt": "Pi')).toMatchObject({ ok: false, incomplete: true })
    expect(parseCommandoUi('')).toMatchObject({ ok: false, incomplete: true })
    expect(parseCommandoUi('{ nope }')).toMatchObject({ ok: false, incomplete: false })
    expect(parseCommandoUi('{"component":"x"}')).toMatchObject({ ok: false, incomplete: false })
  })

  it('returns the same result for the same text', () => {
    const source = '{"component":"approve","prompt":"Same?"}'
    expect(parseCommandoUi(source)).toBe(parseCommandoUi(source))
  })
})

const choice = (multiple = false): CommandoUiBlock => ({ component: 'choice', prompt: 'Archive storage', options: ['SQLite in ~/.commando', 'JSONL, per session', 'Both'], multiple })
const approve: CommandoUiBlock = { component: 'approve', prompt: 'Ship the migration', approveLabel: 'Ship it', rejectLabel: 'Hold' }

describe('answers', () => {
  it('formats a choice in option order', () => {
    expect(formatChoiceAnswer(choice() as never, ['SQLite in ~/.commando'])).toBe('Archive storage: SQLite in ~/.commando')
    expect(formatChoiceAnswer(choice(true) as never, ['Both', 'SQLite in ~/.commando'])).toBe('Archive storage: SQLite in ~/.commando, Both')
  })

  it('formats approval with an optional trimmed note', () => {
    expect(formatApproveAnswer(approve as never, 'Approved')).toBe('Approved: Ship the migration')
    expect(formatApproveAnswer(approve as never, 'Rejected', '  too risky ')).toBe('Rejected: Ship the migration — note: too risky')
  })

  it('matches only its own exact answers', () => {
    expect(matchBlockAnswer(choice(), 'Archive storage: Both')).toBe('Both')
    expect(matchBlockAnswer(choice(), 'Archive storage: Neither')).toBeUndefined()
    expect(matchBlockAnswer(choice(), 'Other prompt: Both')).toBeUndefined()
    expect(matchBlockAnswer(choice(), 'Archive storage: Both, SQLite in ~/.commando')).toBeUndefined()
    expect(matchBlockAnswer(choice(true), 'Archive storage: JSONL, per session, Both')).toBe('JSONL, per session, Both')
    expect(matchBlockAnswer(choice(true), 'Archive storage: Both, SQLite in ~/.commando')).toBeUndefined()
    expect(matchBlockAnswer(approve, 'Approved: Ship the migration')).toBe('Ship it')
    expect(matchBlockAnswer(approve, 'Rejected: Ship the migration — note: too risky')).toBe('Hold — too risky')
    expect(matchBlockAnswer(approve, 'Approved: Ship the migrations')).toBeUndefined()
    expect(matchBlockAnswer({ component: 'checklist', items: [{ label: 'a', done: false }] }, 'a')).toBeUndefined()
  })

  it('settles only on a user message sent after the reply', () => {
    const messages = [{ text: 'Approved: Ship the migration', createdAt: 5 }]
    expect(settledAnswer(approve, 10, messages)).toBeUndefined()
    expect(settledAnswer(approve, 5, messages)).toBe('Ship it')
    expect(settledAnswer(approve, 1, messages)).toBe('Ship it')
    expect(settledAnswer(approve, 1, [])).toBeUndefined()
  })
})

describe('the commando-ui skill', () => {
  it('only teaches blocks that validate, one example per component', () => {
    const skill = readFileSync(new URL('../skills/commando-ui/SKILL.md', import.meta.url), 'utf8')
    const fences = [...skill.matchAll(/^```commando-ui\n([\s\S]*?)\n```$/gm)].map((match) => match[1]!)
    const components = fences.flatMap((source) => {
      const result = parseCommandoUi(source)
      expect(result, source).toMatchObject({ ok: true })
      return result.ok ? result.blocks.map((block) => block.component) : []
    })
    expect(components.sort()).toEqual(['approve', 'checklist', 'choice', 'stats', 'table'])
  })
})
