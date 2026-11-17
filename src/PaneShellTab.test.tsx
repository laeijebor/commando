// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { PaneShellTab, type PaneShellTerminal } from './PaneShellTab'

vi.mock('./TerminalPaneRenderer', () => ({
  TerminalPaneRenderer: ({ paneId, resizeOwner, onInput, onResize }: { paneId: string; resizeOwner: boolean; onInput: (data: string) => void; onResize: (cols: number, rows: number) => void }) =>
    <button type="button" data-resize-owner={resizeOwner} onClick={() => { onInput('ls\r'); onResize(90, 30) }}>terminal {paneId}</button>,
}))

afterEach(cleanup)

const shell = { id: '%30', width: 80, height: 24 } as TmuxPane
const terminal = (): PaneShellTerminal => ({
  onInput: vi.fn(), onInputBytes: vi.fn(), onKey: vi.fn(), onPaste: vi.fn(), onResize: vi.fn(), onRequestReset: vi.fn(),
  onSelectionCopied: vi.fn(), registerSink: vi.fn(() => () => {}),
})
const tab = (props: Partial<Parameters<typeof PaneShellTab>[0]>) => <PaneShellTab shell={undefined} visible connected streaming={false} resizeActive
  ensureShell={vi.fn(async () => '%30')} onVisible={vi.fn()} terminal={terminal()} {...props} />

it('starts the shell only once the tab is shown', async () => {
  const ensureShell = vi.fn(async () => '%30')
  const view = render(tab({ visible: false, ensureShell }))
  expect(ensureShell).not.toHaveBeenCalled()
  await act(async () => { view.rerender(tab({ ensureShell })) })
  expect(ensureShell).toHaveBeenCalledOnce()
  expect(screen.getByRole('status')).toHaveTextContent('Starting a shell…')
})

it('does not start a shell while offline, or when the pane already has one', async () => {
  const ensureShell = vi.fn(async () => '%30')
  const view = render(tab({ connected: false, ensureShell }))
  expect(screen.getByRole('status')).toHaveTextContent('Reconnect to start a shell.')
  await act(async () => { view.rerender(tab({ shell, ensureShell })) })
  expect(ensureShell).not.toHaveBeenCalled()
})

it('shows why the shell could not start and tries again on request', async () => {
  const ensureShell = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('tmux pane action failed')).mockResolvedValue('%30')
  await act(async () => { render(tab({ ensureShell })) })
  expect(screen.getByRole('alert')).toHaveTextContent('tmux pane action failed')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
  expect(ensureShell).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('reports the shell while it is on screen, and mounts the terminal only once it is streamed', () => {
  const onVisible = vi.fn()
  const io = terminal()
  const view = render(tab({ shell, onVisible, terminal: io }))
  expect(onVisible).toHaveBeenLastCalledWith('%30', true)
  expect(screen.queryByRole('button', { name: 'terminal %30' })).not.toBeInTheDocument()

  view.rerender(tab({ shell, streaming: true, onVisible, terminal: io }))
  fireEvent.click(screen.getByRole('button', { name: 'terminal %30' }))
  expect(io.onInput).toHaveBeenCalledWith('%30', 'ls\r')
  expect(io.onResize).toHaveBeenCalledWith('%30', 90, 30)

  view.rerender(tab({ shell, visible: false, streaming: true, onVisible, terminal: io }))
  expect(onVisible).toHaveBeenLastCalledWith('%30', false)
  expect(screen.queryByRole('button', { name: 'terminal %30' })).not.toBeInTheDocument()
})
