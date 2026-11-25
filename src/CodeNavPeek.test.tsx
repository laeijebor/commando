// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeNavFile, CodeNavKind, CodeNavResult } from '../shared/code-nav'
import { CodeNavPeek, groupLocations } from './CodeNavPeek'
import { pierreFileRenders } from './pierreReactMock'

vi.mock('@pierre/diffs/react', () => import('./pierreReactMock'))

afterEach(() => {
  cleanup()
  pierreFileRenders.length = 0
})

const origin = { file: 'src/a.ts', rev: 'worktree', line: 4, character: 6, symbol: 'render' }

const results: Record<CodeNavKind, CodeNavResult> = {
  definition: {
    kind: 'definition', source: 'language-server', rev: 'worktree', truncated: false,
    locations: [{ file: 'src/view.ts', line: 2, character: 16, preview: 'export function render() {', container: 'View' }],
  },
  references: {
    kind: 'references', source: 'text', rev: 'worktree', truncated: true, note: 'Language server starting',
    locations: [
      { file: 'lib/other.ts', line: 9, character: 2, preview: 'render()' },
      { file: 'src/a.ts', line: 4, character: 6, preview: 'const out = render()' },
      { file: 'lib/other.ts', line: 12, character: 0, preview: 'rerender(); render()' },
    ],
  },
  callers: { kind: 'callers', source: 'language-server', rev: 'worktree', truncated: false, locations: [] },
}

const contents: Record<string, string> = {
  'src/view.ts': 'import x\nexport function render() {\n}\n',
  'src/a.ts': 'a\nb\nc\nconst out = render()\n',
  'lib/other.ts': Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n'),
}

function peekApi() {
  return {
    navigate: vi.fn(async (_paneId: string, request: { kind: CodeNavKind }) => results[request.kind]),
    fileAt: vi.fn(async (_paneId: string, file: string, rev: string): Promise<CodeNavFile> => ({ file, rev, contents: contents[file] ?? null, ...(contents[file] ? {} : { unavailable: 'missing' as const }) })),
  }
}

function renderPeek(api = peekApi(), overrides: Partial<Parameters<typeof CodeNavPeek>[0]> = {}) {
  const props = {
    paneId: '%1',
    api,
    origin,
    changedFiles: new Set(['src/a.ts']),
    diffSide: vi.fn((file: string, rev: string) => (file === 'src/a.ts' && rev === 'worktree' ? 'additions' as const : null)),
    onShowInDiff: vi.fn(),
    onOpenInIde: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<CodeNavPeek {...props} />)
  return props
}

describe('groupLocations', () => {
  it('groups by file in result order with changed files first', () => {
    const groups = groupLocations(results.references.locations, new Set(['src/a.ts']))
    expect(groups.map((group) => [group.file, group.changed, group.locations.map((location) => location.line)])).toEqual([
      ['src/a.ts', true, [4]],
      ['lib/other.ts', false, [9, 12]],
    ])
  })
})

describe('CodeNavPeek', () => {
  it('loads the definition first and each other tab only when it is opened, with counts once loaded', async () => {
    const api = peekApi()
    renderPeek(api)
    expect(await screen.findByText('src/view.ts:2')).toBeInTheDocument()
    expect(api.navigate).toHaveBeenCalledExactlyOnceWith('%1', { kind: 'definition', ...origin })
    expect(screen.getByRole('tab', { name: 'Definition 1' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'References' })).toBeInTheDocument()
    expect(screen.getByText('precise')).toBeInTheDocument()
    expect(screen.getByText('View')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'References' }))
    expect(await screen.findByRole('tab', { name: 'References 3+' })).toBeInTheDocument()
    expect(api.navigate).toHaveBeenLastCalledWith('%1', { kind: 'references', ...origin })
    // Text-engine results are flagged as name matches, with the daemon's note.
    expect(screen.getByText('name matches')).toBeInTheDocument()
    expect(screen.getByText('Language server starting')).toBeInTheDocument()
    expect(screen.getByText('More matches exist than are shown.')).toBeInTheDocument()

    // Coming back to a loaded tab does not fetch it again.
    fireEvent.click(screen.getByRole('tab', { name: 'Definition 1' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Callers' }))
    expect(await screen.findByText('No callers found for render')).toBeInTheDocument()
    expect(api.navigate).toHaveBeenCalledTimes(3)
  })

  it('lists changed files first, marked, and highlights the symbol in each preview line', async () => {
    renderPeek()
    fireEvent.click(screen.getByRole('tab', { name: 'References' }))
    const list = await screen.findByRole('listbox', { name: 'References locations' })
    await within(list).findByText('lib/other.ts')
    const groups = within(list).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['src/a.ts', 'lib/other.ts'])
    expect(within(groups[0]).getByText('changed')).toBeInTheDocument()
    expect(within(groups[1]).queryByText('changed')).not.toBeInTheDocument()
    // Whole-word matches only: "rerender" is not the symbol.
    const marks = within(groups[1]).getAllByRole('option')[1].querySelectorAll('mark')
    expect([...marks].map((mark) => mark.textContent)).toEqual(['render'])
    expect(marks[0].previousSibling?.textContent).toBe('rerender(); ')
  })

  it('previews the selected location at the result’s rev with its line selected, caching each file', async () => {
    const api = peekApi()
    renderPeek(api)
    fireEvent.click(screen.getByRole('tab', { name: 'References' }))
    await screen.findByText('src/a.ts:4')
    expect(api.fileAt).toHaveBeenLastCalledWith('%1', 'src/a.ts', 'worktree')
    const file = await screen.findByTestId('pierre-file')
    expect(file).toHaveAttribute('data-file', 'src/a.ts')
    expect(file.querySelector('[data-selected-line]')).toHaveTextContent('const out = render()')
    expect(pierreFileRenders.at(-1)?.selectedLines).toEqual({ start: 4, end: 4 })

    const peek = screen.getByRole('region', { name: 'Navigation for render' })
    fireEvent.keyDown(peek, { key: 'ArrowDown' })
    expect(await screen.findByText('lib/other.ts:9')).toBeInTheDocument()
    expect((await screen.findByTestId('pierre-file')).querySelector('[data-selected-line]')).toHaveTextContent('line 9')
    fireEvent.keyDown(peek, { key: 'ArrowDown' })
    expect(await screen.findByText('lib/other.ts:12')).toBeInTheDocument()
    fireEvent.keyDown(peek, { key: 'ArrowUp' })
    fireEvent.keyDown(peek, { key: 'ArrowUp' })
    expect(await screen.findByText('src/a.ts:4')).toBeInTheDocument()
    expect(api.fileAt).toHaveBeenCalledTimes(2)
  })

  it('reports a file it cannot preview', async () => {
    const api = peekApi()
    api.fileAt.mockResolvedValueOnce({ file: 'src/view.ts', rev: 'worktree', contents: null, unavailable: 'too-large' })
    renderPeek(api)
    expect(await screen.findByText('Too large to preview')).toBeInTheDocument()
    expect(screen.queryByTestId('pierre-file')).not.toBeInTheDocument()
  })

  it('shows navigation errors in the list', async () => {
    const api = peekApi()
    api.navigate.mockRejectedValueOnce(new Error('git grep failed'))
    renderPeek(api)
    expect(await screen.findByRole('alert')).toHaveTextContent('git grep failed')
  })

  it('shows a location in the diff from the button, Enter or a double-click, and opens it in the IDE at its column', async () => {
    const props = renderPeek()
    fireEvent.click(screen.getByRole('tab', { name: 'References' }))
    expect(await screen.findByText('src/a.ts:4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show in diff/ }))
    expect(props.onShowInDiff).toHaveBeenLastCalledWith('src/a.ts', 'additions', 4)
    fireEvent.keyDown(screen.getByRole('region', { name: 'Navigation for render' }), { key: 'Enter' })
    expect(props.onShowInDiff).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: /Open in IDE/ }))
    expect(props.onOpenInIde).toHaveBeenLastCalledWith('src/a.ts', 4, 7)

    // Unchanged files have no diff to show them in.
    fireEvent.click(screen.getAllByRole('option')[1])
    expect(await screen.findByText('lib/other.ts:9')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show in diff/ })).not.toBeInTheDocument()
    fireEvent.doubleClick(screen.getAllByRole('option')[0])
    expect(props.onShowInDiff).toHaveBeenCalledTimes(3)
  })

  it('hides Open in IDE without a session IDE and closes on Esc or the close button', async () => {
    const props = renderPeek(peekApi(), { onOpenInIde: undefined })
    await screen.findByText('src/view.ts:2')
    expect(screen.queryByRole('button', { name: /Open in IDE/ })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Navigation for render' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('drops responses that arrive after it closed', async () => {
    const api = peekApi()
    let finish!: (result: CodeNavResult) => void
    api.navigate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderPeek(api)
    cleanup()
    await act(async () => { finish(results.definition) })
    expect(api.fileAt).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
