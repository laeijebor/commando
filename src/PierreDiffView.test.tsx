// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PierreDiffView } from './PierreDiffView'
import { relativeTime, type FileBlame } from './gitBlame'
import type { GitBlame, GitFileContents } from './gitApi'
import { pierreRenders } from './pierreReactMock'

vi.mock('@pierre/diffs/react', () => import('./pierreReactMock'))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pierreRenders.length = 0
})

const contents: GitFileContents = {
  file: 'a.ts',
  old: { path: 'a.ts', contents: 'one\ntwo\n', rev: 'base' },
  new: { path: 'a.ts', contents: 'one\nTWO\nthree\n', rev: 'worktree' },
}

const now = Math.floor(Date.now() / 1000)
const oldBlame: GitBlame = {
  file: 'a.ts',
  rev: 'base',
  commits: {
    aaaaaaaaaaaa: { sha: 'aaaaaaaaaaaa', author: 'Ada', authorTime: now - 3 * 24 * 3600, summary: 'Add one and two', uncommitted: false },
  },
  lines: ['aaaaaaaaaaaa', 'aaaaaaaaaaaa'],
}
const newBlame: GitBlame = {
  file: 'a.ts',
  rev: 'worktree',
  commits: {
    aaaaaaaaaaaa: oldBlame.commits.aaaaaaaaaaaa,
    '0000000000000000000000000000000000000000': { sha: '0000000000000000000000000000000000000000', author: 'Not Committed Yet', authorTime: now, summary: '', uncommitted: true },
  },
  lines: ['aaaaaaaaaaaa', '0000000000000000000000000000000000000000', '0000000000000000000000000000000000000000'],
}
const blame: FileBlame = { old: oldBlame, new: newBlame, loading: false, error: '' }

function view(overrides: Partial<Parameters<typeof PierreDiffView>[0]> = {}) {
  return (
    <PierreDiffView
      contents={contents}
      display="side-by-side"
      query=""
      activeMatch={0}
      onMatchCountChange={() => undefined}
      blame={null}
      {...overrides}
    />
  )
}

function hoverLine(side: 'deletions' | 'additions', lineNumber: number, lineType: string, altLine: number | null = lineNumber) {
  const lineElement = document.createElement('div')
  if (altLine !== null) lineElement.dataset.altLine = String(altLine)
  lineElement.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 18, width: 800, height: 18, x: 0, y: 0, toJSON: () => ({}) })
  act(() => {
    pierreRenders.at(-1)!.options!.onLineEnter!({
      type: 'diff-line',
      annotationSide: side,
      lineType: lineType as never,
      lineNumber,
      lineElement,
      numberElement: lineElement,
      numberColumn: false,
      event: new MouseEvent('pointermove', { clientX: 40 }) as PointerEvent,
    })
  })
}

describe('PierreDiffView', () => {
  it('maps the layout toggle onto Pierre diff styles', () => {
    const { rerender } = render(view())
    expect(pierreRenders.at(-1)?.options?.diffStyle).toBe('split')
    rerender(view({ display: 'inline' }))
    expect(pierreRenders.at(-1)?.options?.diffStyle).toBe('unified')
  })

  it('passes stable files and options when its props are unchanged, so Pierre does not re-render', () => {
    const { rerender } = render(view())
    const first = pierreRenders.at(-1)!
    rerender(view({ contents: { ...contents, old: { ...contents.old! }, new: { ...contents.new! } }, onMatchCountChange: () => undefined }))
    const second = pierreRenders.at(-1)!
    expect(second).not.toBe(first)
    expect(second.options).toBe(first.options)
    expect(second.oldFile).toBe(first.oldFile)
    expect(second.newFile).toBe(first.newFile)
  })

  it('renders deleted files from the old side only', () => {
    render(view({ contents: { file: 'a.ts', old: contents.old, new: null } }))
    expect(pierreRenders.at(-1)).toMatchObject({ newFile: null, oldFile: { name: 'a.ts', contents: 'one\ntwo\n' } })
  })

  it('reports how many matches its rendered rows hold', () => {
    const onMatchCountChange = vi.fn()
    const { rerender } = render(view({ query: 'two', onMatchCountChange }))
    expect(onMatchCountChange).toHaveBeenLastCalledWith(2)
    rerender(view({ query: 'nothing', onMatchCountChange }))
    expect(onMatchCountChange).toHaveBeenLastCalledWith(0)
  })

  it('shows old-side blame for deletions and new-side blame for additions and context', () => {
    vi.useFakeTimers()
    render(view({ blame }))
    hoverLine('deletions', 2, 'change-deletion')
    expect(document.querySelector('.pierre-blame-hint')).toHaveTextContent('Ada, 3 days ago · Add one and two')

    hoverLine('additions', 2, 'change-addition')
    expect(document.querySelector('.pierre-blame-hint')).toHaveTextContent('Uncommitted changes')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Uncommitted')

    // A context row in the old column looks up its new-side line number.
    hoverLine('deletions', 1, 'context', 1)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('aaaaaaaa')
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ada')
    expect(screen.getByRole('tooltip')).toHaveTextContent('Add one and two')

    act(() => { pierreRenders.at(-1)!.options!.onLineLeave!({} as never) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(document.querySelector('.pierre-blame-hint')).not.toBeInTheDocument()
  })

  it('keys working-tree files by content, so a same-length edit re-renders', () => {
    const { rerender } = render(view())
    const before = pierreRenders.at(-1)!.newFile!.cacheKey
    rerender(view({ contents: { ...contents, new: { ...contents.new!, contents: 'one\nTWX\nthree\n' } } }))
    expect(pierreRenders.at(-1)!.newFile!.cacheKey).not.toBe(before)
    expect(pierreRenders.at(-1)!.oldFile!.cacheKey).toBe(pierreRenders[0].oldFile!.cacheKey)
  })

  it('never attributes an added line to the old file while new-side blame is loading', () => {
    vi.useFakeTimers()
    render(view({ blame: { old: oldBlame, loading: true, error: '' } }))
    // Pierre gives changed rows no data-alt-line.
    hoverLine('additions', 2, 'change-addition', null)
    expect(document.querySelector('.pierre-blame-hint')).toHaveTextContent('Loading blame')
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows nothing on hover while blame is off', () => {
    render(view())
    hoverLine('additions', 1, 'context')
    expect(document.querySelector('.pierre-blame-hint')).not.toBeInTheDocument()
  })
})

describe('relativeTime', () => {
  it('describes ages in the largest whole unit', () => {
    const nowMs = Date.UTC(2026, 10, 25)
    const seconds = nowMs / 1000
    expect(relativeTime(seconds - 10, nowMs)).toBe('just now')
    expect(relativeTime(seconds - 2 * 3600, nowMs)).toBe('2 hours ago')
    expect(relativeTime(seconds - 24 * 3600, nowMs)).toBe('yesterday')
    expect(relativeTime(seconds - 400 * 24 * 3600, nowMs)).toBe('last year')
  })
})
