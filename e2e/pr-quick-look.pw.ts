import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { CommandoSnapshot } from '../shared/protocol'
import type { PrConflicts, PrDetails } from '../shared/pr-quick-look'
import type { PrSummary } from '../src/prsApi'

const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5298)
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } } } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

test('quick look shows actual-target conflicts and attaches replies to their original comments', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const snapshot: CommandoSnapshot = { revision: 1, capturedAt: Date.now(), ports: [], panes: [], windows: [],
    sessions: [{ id: '$1', name: 'PR fixture', attached: true, activeWindowId: null, windowIds: [] }] }
  const pr: PrSummary = { number: 12, title: 'Conflict and conversation preview', url: 'https://github.com/acme/app/pull/12',
    state: 'open', isDraft: false, author: 'QA', bodyExcerpt: 'Full description', additions: 2, deletions: 1,
    changedFiles: 1, commitCount: 1, unresolvedThreads: 1, threadsTruncated: false, reviewDecision: null,
    reviews: [], requestedReviewers: [], conflicting: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: null,
    createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-02T09:00:00Z', headRefName: 'feature/mail', baseRefName: 'release/mail',
    headRefOid: 'b'.repeat(40), baseRefOid: 'a'.repeat(40), viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null }
  const details: PrDetails = { body: '# Full description', checks: [], mergeTarget: { branch: 'release/mail', oid: pr.baseRefOid }, conversation: [
    { id: '2:101', commentId: 101, author: 'Reviewer', body: 'Original inline finding', path: 'worker.ts', line: 10, kind: 'inline comment', createdAt: '2026-01-01T09:00:00Z', url: `${pr.url}#discussion_r101` },
    { id: '2:102', commentId: 102, author: 'Reviewer', body: 'Different finding on the same file', path: 'worker.ts', line: 22, kind: 'inline comment', createdAt: '2026-01-01T10:00:00Z', url: `${pr.url}#discussion_r102` },
    { id: '1:303', reviewId: 303, author: 'Author', body: '', kind: 'commented', createdAt: '2026-01-02T09:00:00Z', url: pr.url },
    { id: '2:103', commentId: 103, replyTo: 101, reviewId: 303, author: 'Author', body: 'Reply to the original finding', path: 'worker.ts', kind: 'inline comment', createdAt: '2026-01-02T09:00:00Z', url: `${pr.url}#discussion_r103` },
  ] }
  const conflicts: PrConflicts = { state: 'conflicting', baseRefName: pr.baseRefName, headRefName: pr.headRefName,
    baseOid: pr.baseRefOid, headOid: pr.headRefOid, fetchedAt: Date.now(), truncated: false, messages: ['CONFLICT in worker.ts'],
    files: [{ path: 'worker.ts', kind: 'CONFLICT (contents)', content: `<<<<<<< ${pr.baseRefOid}\ntarget content\n=======\nPR content\n>>>>>>> ${pr.headRefOid}`, truncated: false }] }
  let conflictReads = 0
  let cleanMerge = false
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => { socket.send(JSON.stringify({ type: 'snapshot', snapshot })); socket.onMessage(() => {}) })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: unknown = {}
    if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (path === '/api/snapshot') json = snapshot
    else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$1'], groupingMode: 'manual' } }
    else if (path === '/api/session-management/archives') json = { archives: [] }
    else if (path === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: ['acme/app'], recentRepos: [], lastRepo: 'acme/app', lastFilter: 'open', lastScope: 'mine' } }
    else if (path === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/app', pinned: true }] }
    else if (path === '/api/prs') json = { list: { repo: 'acme/app', filter: 'open', viewer: 'QA', totalCount: 1, pullRequests: [pr], truncated: false, mineTruncated: false, fetchedAt: Date.now() } }
    else if (path === '/api/prs/details') json = { details }
    else if (path === '/api/prs/threads') json = { threads: { repo: 'acme/app', number: 12, threads: [], truncated: false, fetchedAt: Date.now() } }
    else if (path === '/api/prs/conflicts') {
      conflictReads++
      json = { conflicts: cleanMerge ? { ...conflicts, state: 'clean', files: [], messages: [] } : conflicts }
    }
    await route.fulfill({ json })
  })
  await page.goto(`http://127.0.0.1:${port}/#token=pr-quick-look-fixture`)
  await page.getByRole('tab', { name: /^prs$/i }).click()
  await expect(page.getByLabel('Merge target: release/mail')).toBeVisible()
  await page.getByRole('button', { name: 'Quick look at PR #12' }).click()
  await expect(page.getByRole('note')).toContainText('Merges into release/mail, not main.')
  expect(conflictReads).toBe(0)
  await page.getByRole('button', { name: 'View conflicts', exact: true }).click()
  await expect(page.getByText('<<<<<<< Target (release/mail)', { exact: true })).toBeVisible()
  await expect(page.getByText('>>>>>>> PR (feature/mail)', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('conflicts.png') })
  cleanMerge = true
  await page.getByRole('button', { name: 'Refresh conflicts', exact: true }).click()
  await expect(page.getByText('No merge conflicts', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View conflicts', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  const parent = page.locator('article[data-comment-id="2:101"]')
  await expect(parent.locator('article[data-comment-id="2:103"]')).toContainText('Reply to the original finding')
  await expect(page.locator('article[data-comment-id="2:102"]')).not.toContainText('Reply to the original finding')
  await expect(page.locator('article[data-comment-id="1:303"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('threaded-conversation.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Quick look at PR #12' })).toBeFocused()
  expect(errors).toEqual([])
})
