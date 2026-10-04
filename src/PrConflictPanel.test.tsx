// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { PrConflictPanel } from './PrConflictPanel'
import type { PrsApiClient } from './prsApi'

afterEach(cleanup)
const result = {
  state: 'conflicting',
  baseRefName: 'release',
  headRefName: 'feature',
  baseOid: 'a'.repeat(40),
  headOid: 'b'.repeat(40),
  messages: ['CONFLICT in app.ts'],
  truncated: false,
  fetchedAt: Date.now(),
  files: [
    {
      path: 'app.ts',
      kind: 'CONFLICT (contents)',
      content: '<<<<<<< ' + 'a'.repeat(40) + '\ntarget line\n=======\nPR line\n>>>>>>> ' + 'b'.repeat(40),
      truncated: false,
    },
    { path: 'image.png', kind: 'CONFLICT (binary)', content: null, truncated: false },
  ],
}

it('shows actual-target conflict markers, file navigation, and binary fallback', async () => {
  const api = { conflicts: vi.fn().mockResolvedValue(result) } as unknown as PrsApiClient
  render(<PrConflictPanel repo="acme/widgets" number={12} api={api} onLoaded={vi.fn()} />)
  expect(await screen.findByText('Merge conflicts · 2 files')).toBeVisible()
  expect(screen.getByText('<<<<<<< Target (release)')).toBeVisible()
  expect(screen.getByText('>>>>>>> PR (feature)')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /image.png/ }))
  expect(screen.getByText(/No text preview is available/)).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter conflicting files' }), {
    target: { value: 'missing' },
  })
  expect(screen.getByText('No matching conflicting files.')).toBeVisible()
})

it('retries inspection failures and distinguishes a clean merge from readiness', async () => {
  const api = {
    conflicts: vi
      .fn()
      .mockRejectedValueOnce(new Error('Target changed'))
      .mockResolvedValue({ ...result, state: 'clean', files: [], messages: [] }),
  } as unknown as PrsApiClient
  render(<PrConflictPanel repo="acme/widgets" number={12} api={api} onLoaded={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Target changed')
  fireEvent.click(screen.getByRole('button', { name: 'Retry conflict inspection' }))
  expect(await screen.findByText('No merge conflicts')).toBeVisible()
  expect(screen.getByText(/Checks and review requirements can still block merging/)).toBeVisible()
})
