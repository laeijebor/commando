// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionIde } from '../shared/protocol'
import { ideFrameUrl, SessionIdeView } from './SessionIdeView'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const ide: SessionIde = { id: 'ide-1111111111111111', sessionIds: ['$1', '$2'], workspacePath: '/worktree', state: 'ready', generation: 1, url: '/ide/ide-1111111111111111/' }
const props = {
  active: true, sessionName: 'work', ide, ides: [ide], openedFrames: new Set([`${ide.id}:${ide.generation}`]),
  pending: false, error: '', connected: true, onOpen: vi.fn(), onDetach: vi.fn(), onTerminal: vi.fn(),
}

it('keeps the same editor iframe mounted when hidden or switched to another attached session', () => {
  const { container, rerender } = render(<SessionIdeView {...props} />)
  const frame = container.querySelector('iframe')!
  expect(frame).not.toHaveAttribute('hidden')
  expect(screen.getByText(/shared by 2 sessions/)).toBeInTheDocument()
  rerender(<SessionIdeView {...props} active={false} />)
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame).toHaveAttribute('hidden')
  rerender(<SessionIdeView {...props} sessionName="other session" />)
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame).not.toHaveAttribute('hidden')
})

it('does not load other worktree IDEs just because they are attached in the daemon', () => {
  const second = { ...ide, id: 'ide-2222222222222222', workspacePath: '/other' }
  const { container } = render(<SessionIdeView {...props} ides={[ide, second]} />)
  expect(container.querySelectorAll('iframe')).toHaveLength(1)
})

it('shows an actionable failed startup and removes detached frames', () => {
  const { container, rerender } = render(<SessionIdeView {...props} />)
  rerender(<SessionIdeView {...props} ide={{ ...ide, state: 'failed', error: 'Install code-server' }} ides={[]} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Install code-server')
  expect(screen.getByRole('button', { name: 'Retry IDE' })).toBeEnabled()
  expect(container.querySelector('iframe')).toBeNull()
})

it('minimizes without detaching and confirms detachment inside the app', () => {
  const onTerminal = vi.fn()
  const onDetach = vi.fn()
  const nativeConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('Native dialogs are unavailable in this tile') })
  const { container } = render(<SessionIdeView {...props} onTerminal={onTerminal} onDetach={onDetach} />)
  const frame = container.querySelector('iframe')
  fireEvent.click(screen.getByRole('button', { name: 'Minimize IDE' }))
  expect(onTerminal).toHaveBeenCalledOnce()
  expect(onDetach).not.toHaveBeenCalled()
  expect(container.querySelector('iframe')).toBe(frame)

  fireEvent.click(screen.getByRole('button', { name: 'Detach IDE' }))
  expect(container.querySelector('details')).toHaveAttribute('open')
  expect(screen.getByRole('group', { name: 'Confirm IDE detachment' })).toHaveTextContent('Other attached sessions will keep the shared IDE running')
  expect(onDetach).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(container.querySelector('details')).not.toHaveAttribute('open')
  expect(onDetach).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Detach IDE' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm detach' }))
  expect(onDetach).toHaveBeenCalledOnce()
  expect(nativeConfirm).not.toHaveBeenCalled()
})

it('warns before stopping the last attachment and resets confirmation when changing sessions', () => {
  const { container, rerender } = render(<SessionIdeView {...props} sessionId="$1" ide={{ ...ide, sessionIds: ['$1'] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Detach IDE' }))
  expect(screen.getByRole('group', { name: 'Confirm IDE detachment' })).toHaveTextContent('Save your files first')
  rerender(<SessionIdeView {...props} sessionId="$2" />)
  expect(container.querySelector('details')).not.toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: 'Detach IDE' }))
  fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(container.querySelector('details')).not.toHaveAttribute('open')
})

it('shows detachment progress and keeps API errors visible without replacing the editor', () => {
  const { container } = render(<SessionIdeView {...props} pending detaching error="Unable to detach IDE: daemon unavailable" />)
  expect(screen.getByRole('button', { name: 'Detaching…' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('alert')).toHaveTextContent('Unable to detach IDE')
  expect(container.querySelector('iframe')).not.toHaveAttribute('hidden')
})

it('starts a newly loaded IDE on a requested file without reloading it later', () => {
  const key = `${ide.id}:${ide.generation}`
  const { container, rerender } = render(<SessionIdeView {...props} initialFiles={{ [key]: { path: '/worktree/src/a b#.ts', revision: 0 } }} />)
  const frame = container.querySelector('iframe')!
  const src = new URL(frame.getAttribute('src')!, window.location.href)
  expect(src.pathname).toBe('/ide/ide-1111111111111111/')
  expect(JSON.parse(src.searchParams.get('payload')!)).toEqual([['openFile', `vscode-remote://${window.location.host}/worktree/src/a%20b%23.ts`]])
  rerender(<SessionIdeView {...props} initialFiles={{ [key]: { path: '/worktree/other.ts', revision: 0 } }} />)
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame.getAttribute('src')).toBe(`${src.pathname}${src.search}`)
  // A new revision reloads the window on the file the daemon could not target.
  rerender(<SessionIdeView {...props} initialFiles={{ [key]: { path: '/worktree/other.ts', revision: 1 } }} />)
  const reloaded = container.querySelector('iframe')!
  expect(reloaded).not.toBe(frame)
  expect(reloaded.getAttribute('src')).toContain(encodeURIComponent('/worktree/other.ts'))
})

it('waits for a restarted IDE to be authorized before loading its window', () => {
  const { container } = render(<SessionIdeView {...props} ides={[{ ...ide, generation: 2 }]} ide={{ ...ide, generation: 2 }} />)
  expect(container.querySelector('iframe')).toBeNull()
})

it('keeps absolute editor origins and plain URLs without a file', () => {
  expect(ideFrameUrl('http://127.0.0.1:5000/ide/x/?folder=%2Fw')).toBe('http://127.0.0.1:5000/ide/x/?folder=%2Fw')
  const url = new URL(ideFrameUrl('http://127.0.0.1:5000/ide/x/?folder=%2Fw', '/w/a.ts'))
  expect(url.searchParams.get('folder')).toBe('/w')
  expect(JSON.parse(url.searchParams.get('payload')!)).toEqual([['openFile', 'vscode-remote://127.0.0.1:5000/w/a.ts']])
})
