// Test double for '@pierre/diffs/react': jsdom can't run Pierre's custom element, shadow root or
// highlighter worker, so this renders each side's lines as plain rows with Pierre's data attributes
// and records the props it was given. Use with `vi.mock('@pierre/diffs/react', () => import('./pierreReactMock'))`.
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { FileContents, FileDiffOptions, FileOptions, SelectedLineRange } from '@pierre/diffs/react'

export type MockDiffProps = {
  oldFile: FileContents | null
  newFile: FileContents | null
  options?: FileDiffOptions<undefined, undefined>
}

export const pierreRenders: MockDiffProps[] = []

export type MockFileProps = {
  file: FileContents
  options?: FileOptions<undefined, undefined>
  selectedLines?: SelectedLineRange | null
}

export const pierreFileRenders: MockFileProps[] = []

export function WorkerPoolContextProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function rows(file: FileContents | null, side: 'deletions' | 'additions', lineType: string) {
  if (!file) return null
  return (
    <code data-code="" {...{ [`data-${side}`]: '' }}>
      <div data-content="">
        {file.contents.split('\n').filter((line, index, lines) => line !== '' || index < lines.length - 1).map((line, index) => (
          <div key={index} data-line={index + 1} data-alt-line={index + 1} data-line-type={lineType}>{line}</div>
        ))}
      </div>
    </code>
  )
}

export function MultiFileDiff(props: MockDiffProps) {
  pierreRenders.push(props)
  const ref = useRef<HTMLPreElement>(null)
  const { oldFile, newFile, options } = props
  // Pierre reports each render that changes the DOM; the view re-scans search matches then.
  useLayoutEffect(() => {
    if (ref.current) options?.onPostRender?.(ref.current, undefined as never, 'mount')
  }, [oldFile, newFile, options])
  return (
    <pre ref={ref} data-diff="" data-diff-type={options?.diffStyle} data-testid="pierre-diff">
      {rows(oldFile, 'deletions', 'change-deletion')}
      {rows(newFile, 'additions', 'change-addition')}
    </pre>
  )
}

/** The single-file view: one row per line, the selected lines marked as Pierre marks them. */
export function File(props: MockFileProps) {
  pierreFileRenders.push(props)
  const ref = useRef<HTMLPreElement>(null)
  const { file, options, selectedLines } = props
  useLayoutEffect(() => {
    if (ref.current) options?.onPostRender?.(ref.current, undefined as never, 'mount')
  }, [file, options, selectedLines])
  const selected = (line: number) => selectedLines != null && line >= selectedLines.start && line <= selectedLines.end
  return (
    <pre ref={ref} data-file={file.name} data-testid="pierre-file">
      <code data-code="">
        <div data-content="">
          {file.contents.split('\n').filter((line, index, lines) => line !== '' || index < lines.length - 1).map((line, index) => (
            <div key={index} data-line={index + 1} {...(selected(index + 1) ? { 'data-selected-line': '' } : {})}>{line}</div>
          ))}
        </div>
      </code>
    </pre>
  )
}
