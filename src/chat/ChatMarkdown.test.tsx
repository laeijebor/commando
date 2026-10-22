// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './ChatTimeline'

afterEach(cleanup)

describe('chat Markdown links', () => {
  it('opens bare URLs, Markdown links and URLs written as inline code', () => {
    render(<Markdown text={'Open http://127.0.0.1:4330/a, [the page](http://127.0.0.1:4330/b) or `http://127.0.0.1:4330/c` in your browser.'} />)
    expect(screen.getByRole('link', { name: 'http://127.0.0.1:4330/a' })).toHaveAttribute('href', 'http://127.0.0.1:4330/a')
    expect(screen.getByRole('link', { name: 'the page' })).toHaveAttribute('href', 'http://127.0.0.1:4330/b')
    const code = screen.getByRole('link', { name: 'http://127.0.0.1:4330/c' })
    expect(code).toHaveAttribute('href', 'http://127.0.0.1:4330/c')
    expect(code).toHaveAttribute('target', '_blank')
    expect(code.querySelector('code')).toHaveTextContent('http://127.0.0.1:4330/c')
  })

  it('keeps an explicit link whose label is a code-formatted URL', () => {
    render(<Markdown text={'See [`https://example.com`](https://example.com/docs).'} />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://example.com/docs')
  })

  it('leaves other inline code and fenced URLs as plain code', () => {
    render(<Markdown text={'Run `npm run dev`, not `javascript:alert(1)` or `see https://x.dev`.\n\n```\nhttps://example.com\n```\n'} />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})
