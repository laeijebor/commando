// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPre, MermaidDiagram } from './MarkdownCode'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

afterEach(() => {
  cleanup()
  mermaid.render.mockReset()
})

function renderMarkdown(body: string) {
  return render(
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={{ pre: MarkdownPre }}>
      {body}
    </Markdown>,
  )
}

describe('MarkdownPre', () => {
  it('renders mermaid fences as diagrams through sanitised markdown', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"><text>A to B</text></svg>' })
    renderMarkdown('Intro\n\n```mermaid\ngraph LR\n  A --> B\n```\n')

    expect(await screen.findByTestId('diagram')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-[a-zA-Z0-9-]+$/), 'graph LR\n  A --> B')
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }))
  })

  it('falls back to the source when mermaid cannot parse it', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error'))
    renderMarkdown('```mermaid\nnot a diagram\n```\n')

    expect(await screen.findByText("Couldn't render this Mermaid diagram.")).toBeInTheDocument()
    expect(screen.getByText('not a diagram')).toBeInTheDocument()
  })

  it('keeps the last good diagram while an edited source fails, and renders each change under a fresh id', async () => {
    mermaid.render.mockResolvedValueOnce({ svg: '<svg data-testid="first"></svg>' })
    const { rerender } = render(<MermaidDiagram source="graph LR\n  A --> B" />)
    expect(await screen.findByTestId('first')).toBeInTheDocument()

    mermaid.render.mockRejectedValueOnce(new Error('Parse error'))
    rerender(<MermaidDiagram source="graph LR\n  A --> B[Lab" />)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('first')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't render this Mermaid diagram.")).not.toBeInTheDocument()

    mermaid.render.mockResolvedValueOnce({ svg: '<svg data-testid="second"></svg>' })
    rerender(<MermaidDiagram source="graph LR\n  A --> B[Label]" />)
    expect(await screen.findByTestId('second')).toBeInTheDocument()
    const ids = mermaid.render.mock.calls.map(([id]) => id)
    expect(new Set(ids).size).toBe(3)
  })

  it('colours diff fences line by line', () => {
    const { container } = renderMarkdown('```diff\n context\n-removed\n+added\n@@ hunk @@\n```\n')

    expect(container.querySelector('pre.markdown-diff .del')).toHaveTextContent('-removed')
    expect(container.querySelector('pre.markdown-diff .add')).toHaveTextContent('+added')
    expect(container.querySelector('pre.markdown-diff .hunk')).toHaveTextContent('@@ hunk @@')
    expect(container.querySelectorAll('pre.markdown-diff span')).toHaveLength(4)
  })

  it('leaves other code blocks alone', () => {
    const { container } = renderMarkdown('```ts\nconst a = 1\n```\n')

    expect(container.querySelector('pre > code.language-ts')).toHaveTextContent('const a = 1')
    expect(mermaid.render).not.toHaveBeenCalled()
  })
})
