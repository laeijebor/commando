// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrDiffPatch } from './PrDiffPatch'
import type { PrsApiClient } from './prsApi'

afterEach(cleanup)
const patch = '@@ -1 +1 @@\n-const value = 1\n+const value = 2'

describe('PR Delta patches', () => {
  it('uses shared ANSI spans for syntax and word highlights without interpreting HTML', async () => {
    const renderDiff = vi.fn().mockResolvedValue('\x1b[38;2;180;130;250mconst\x1b[0m value = \x1b[48;2;30;70;40m2\x1b[0m\n<script>bad()</script>')
    render(<PrDiffPatch path="app.ts" patch={patch} api={{ renderDiff } as unknown as PrsApiClient} />)
    const output = await screen.findByLabelText('Delta syntax-highlighted diff')
    expect(renderDiff).toHaveBeenCalledWith('app.ts', patch, 120)
    expect(screen.getByText('const')).toHaveStyle({ color: 'rgb(180, 130, 250)' })
    expect(screen.getByText('2')).toHaveStyle({ backgroundColor: 'rgb(30, 70, 40)' })
    expect(output.querySelector('script')).toBeNull()
    expect(output).toHaveTextContent('<script>bad()</script>')
  })

  it('keeps a plain patch on failure and retries highlighting without fetching GitHub again', async () => {
    const renderDiff = vi.fn().mockRejectedValueOnce(new Error('Delta is not installed')).mockResolvedValue('highlighted')
    render(<PrDiffPatch path="app.ts" patch={patch} api={{ renderDiff } as unknown as PrsApiClient} />)
    expect(await screen.findByText(/Delta is not installed.*Showing the plain patch/)).toBeVisible()
    expect(screen.getByText('+const value = 2')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry highlighting' }))
    expect(await screen.findByLabelText('Delta syntax-highlighted diff')).toHaveTextContent('highlighted')
    expect(renderDiff).toHaveBeenCalledTimes(2)
  })

  it('ignores a render that finishes after the selected file changes', async () => {
    let finish!: (value: string) => void
    const renderDiff = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve })).mockResolvedValue('current')
    const api = { renderDiff } as unknown as PrsApiClient
    const view = render(<PrDiffPatch key="old.ts" path="old.ts" patch={patch} api={api} />)
    await waitFor(() => expect(renderDiff).toHaveBeenCalledTimes(1))
    view.rerender(<PrDiffPatch key="new.ts" path="new.ts" patch={patch} api={api} />)
    expect(await screen.findByLabelText('Delta syntax-highlighted diff')).toHaveTextContent('current')
    await act(async () => finish('stale'))
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
  })
})
