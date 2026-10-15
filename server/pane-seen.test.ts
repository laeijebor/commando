import { describe, expect, it } from 'vitest'
import { PaneSeen } from './pane-seen.js'

describe('PaneSeen', () => {
  it('records when panes were last seen and reports only changes', () => {
    const seen = new PaneSeen()
    expect(seen.mark(['%1', '%2'], 10)).toEqual({ '%1': 10, '%2': 10 })
    expect(seen.mark(['%1'], 10)).toEqual({})
    expect(seen.mark(['%1'], 20)).toEqual({ '%1': 20 })
    expect(seen.snapshot()).toEqual({ '%1': 20, '%2': 10 })
  })

  it('forgets panes that are gone', () => {
    const seen = new PaneSeen()
    seen.mark(['%1', '%2'], 10)
    seen.retain(new Set(['%2']))
    expect(seen.snapshot()).toEqual({ '%2': 10 })
  })
})
