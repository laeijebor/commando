import { describe, expect, it } from 'vitest'

import { toggleMarkdownTaskAt } from './markdownTasks'

function offsetOf(markdown: string, item: string): number {
  const offset = markdown.indexOf(item)
  expect(offset).toBeGreaterThanOrEqual(0)
  return offset
}

describe('toggleMarkdownTaskAt', () => {
  it('ticks an unchecked item and unticks a checked one', () => {
    const markdown = '- [ ] Integrate UI'
    const ticked = toggleMarkdownTaskAt(markdown, 0)
    expect(ticked).toBe('- [x] Integrate UI')
    expect(toggleMarkdownTaskAt(ticked!, 0)).toBe('- [ ] Integrate UI')
  })

  it('toggles only the clicked item when several repeat the same text', () => {
    const markdown = '- [ ] Review\n- [ ] Review\n- [ ] Review'
    const second = markdown.indexOf('- [ ] Review', 1)

    expect(toggleMarkdownTaskAt(markdown, second)).toBe('- [ ] Review\n- [x] Review\n- [ ] Review')
  })

  it('keeps indentation, bullet style, and uppercase marks intact', () => {
    const markdown = '* Parent\n  + [X] Nested\n\n1. [ ] Ordered\n2) [ ] Paren'

    expect(toggleMarkdownTaskAt(markdown, offsetOf(markdown, '+ [X] Nested')))
      .toBe('* Parent\n  + [ ] Nested\n\n1. [ ] Ordered\n2) [ ] Paren')
    expect(toggleMarkdownTaskAt(markdown, offsetOf(markdown, '1. [ ] Ordered')))
      .toBe('* Parent\n  + [X] Nested\n\n1. [x] Ordered\n2) [ ] Paren')
    expect(toggleMarkdownTaskAt(markdown, offsetOf(markdown, '2) [ ] Paren')))
      .toBe('* Parent\n  + [X] Nested\n\n1. [ ] Ordered\n2) [x] Paren')
  })

  it('leaves the note alone when the offset is not a task item', () => {
    const markdown = '- [ ] Integrate UI\n- Plain bullet\n\nParagraph'

    expect(toggleMarkdownTaskAt(markdown, offsetOf(markdown, '- Plain bullet'))).toBeNull()
    expect(toggleMarkdownTaskAt(markdown, offsetOf(markdown, 'Paragraph'))).toBeNull()
    expect(toggleMarkdownTaskAt(markdown, -1)).toBeNull()
    expect(toggleMarkdownTaskAt(markdown, markdown.length)).toBeNull()
    expect(toggleMarkdownTaskAt(markdown, 1.5)).toBeNull()
  })
})
