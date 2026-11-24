// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { CursorCloudStrip } from './CursorCloudStrip'

afterEach(cleanup)
const cloud = { provider: 'cursor' as const, repoUrl: 'https://github.com/acme/app' }

it('shows cloud identity before the working branch and URLs arrive', () => {
  render(<CursorCloudStrip cloud={cloud} />)
  expect(screen.getByRole('region', { name: 'Cursor cloud' })).toHaveTextContent('☁️ Cursor cloud · acme/app')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Check out locally/ })).not.toBeInTheDocument()
})

it('links the working branch, PR and Cursor agent and opens PRs in the panel', () => {
  const onOpenPr = vi.fn()
  const details = { ...cloud, startingRef: 'main', branch: 'cursor/fix', prUrl: `${cloud.repoUrl}/pull/42`, webUrl: 'https://cursor.com/agents/bc-test123' }
  render(<CursorCloudStrip cloud={details} onOpenPr={onOpenPr} />)
  expect(screen.getByRole('link', { name: 'cursor/fix' })).toHaveAttribute('href', `${cloud.repoUrl}/tree/cursor/fix`)
  expect(screen.getByRole('link', { name: 'Open on cursor.com' })).toHaveAttribute('href', details.webUrl)
  const pr = screen.getByRole('link', { name: 'PR #42' })
  expect(pr).toHaveAttribute('href', details.prUrl)
  fireEvent.click(pr)
  expect(onOpenPr).toHaveBeenCalledWith('acme/app', 42, 'Description')
  fireEvent.click(pr, { ctrlKey: true })
  expect(onOpenPr).toHaveBeenCalledOnce()
})

it('keeps a normal PR link when no panel handler is supplied', () => {
  render(<CursorCloudStrip cloud={{ ...cloud, prUrl: `${cloud.repoUrl}/pull/5` }} />)
  expect(screen.getByRole('link', { name: 'PR #5' })).toHaveAttribute('href', `${cloud.repoUrl}/pull/5`)
})
