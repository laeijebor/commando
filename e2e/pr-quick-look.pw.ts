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

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
test(`${viewport.width}px: quick look supports replies, resolve/reopen, conflicts, and refresh`, async ({ page }, testInfo) => {
  await page.setViewportSize(viewport)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const snapshot: CommandoSnapshot = { revision: 1, capturedAt: Date.now(), ports: [], panes: [], windows: [],
    sessions: [{ id: '$1', name: 'PR fixture', attached: true, activeWindowId: null, windowIds: [] }] }
  const pr: PrSummary = { number: 12, title: 'Conflict and conversation preview', url: 'https://github.com/acme/app/pull/12',
    state: 'open', isDraft: false, author: 'QA', bodyExcerpt: 'Full description', additions: 2, deletions: 1,
    changedFiles: 1, commitCount: 1, unresolvedThreads: 2, unansweredThreads: 1, threadsTruncated: false, reviewDecision: null,
    reviews: [], requestedReviewers: [], conflicting: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: null,
    createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-02T09:00:00Z', headRefName: 'feature/mail', baseRefName: 'release/mail',
    headRefOid: 'b'.repeat(40), baseRefOid: 'a'.repeat(40), viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null }
  let activePr = pr
  const thread = (id: number) => ({ id: `PRRT_${id}`, commentId: id, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true })
  const details: PrDetails = { body: '# Full description', checks: [], unresolvedThreads: 2, headOid: pr.headRefOid, mergeTarget: { branch: 'release/mail', oid: pr.baseRefOid }, conversation: [
    { id: '2:101', commentId: 101, thread: thread(101), author: 'Reviewer', body: 'Original inline finding', path: 'worker.ts', line: 10, kind: 'inline comment', createdAt: '2026-01-01T09:00:00Z', url: `${pr.url}#discussion_r101` },
    { id: '2:102', commentId: 102, thread: thread(102), author: 'Reviewer', body: 'Different finding on the same file', path: 'worker.ts', line: 22, kind: 'inline comment', createdAt: '2026-01-01T10:00:00Z', url: `${pr.url}#discussion_r102` },
    { id: '1:303', reviewId: 303, author: 'Author', body: '', kind: 'commented', createdAt: '2026-01-02T09:00:00Z', url: pr.url },
    { id: '2:103', commentId: 103, replyTo: 101, reviewId: 303, author: 'Author', body: 'Reply to the original finding', path: 'worker.ts', kind: 'inline comment', createdAt: '2026-01-02T09:00:00Z', url: `${pr.url}#discussion_r103` },
  ] }
  const conflicts: PrConflicts = { state: 'conflicting', baseRefName: pr.baseRefName, headRefName: pr.headRefName,
    baseOid: pr.baseRefOid, headOid: pr.headRefOid, fetchedAt: Date.now(), truncated: false, messages: ['CONFLICT in worker.ts'],
    files: [{ path: 'worker.ts', kind: 'CONFLICT (contents)', content: `<<<<<<< ${pr.baseRefOid}\ntarget content\n=======\nPR content\n>>>>>>> ${pr.headRefOid}`, truncated: false }] }
  let conflictReads = 0
  let cleanMerge = false
  const writes: Array<{ repo: string; number: number; threadId: string; action: string; body?: string }> = []
  let rejectReply = true
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
    else if (path === '/api/prs') json = { list: { repo: 'acme/app', filter: 'open', viewer: 'QA', totalCount: 1, pullRequests: [activePr], truncated: false, mineTruncated: false, fetchedAt: Date.now() } }
    else if (path === '/api/prs/details') json = { details: activePr.headRefOid === pr.headRefOid ? details : { ...details, body: '# Updated description',
      mergeTarget: { branch: activePr.baseRefName, oid: activePr.baseRefOid }, headOid: activePr.headRefOid,
      checks: [{ name: 'updated-check', state: 'pass', url: pr.url }],
      conversation: details.conversation.map((entry) => entry.id === '2:103' ? { ...entry, body: 'Reply after retarget' } : entry),
    } }
    else if (path === '/api/prs/thread-action') {
      const write = route.request().postDataJSON()
      writes.push(write)
      if (write.action === 'reply' && rejectReply) {
        rejectReply = false
        await route.fulfill({ status: 403, json: { error: 'Reply temporarily denied' } })
        return
      }
      if (write.action === 'reply') {
        details.conversation.push({ id: '2:104', commentId: 104, replyTo: 102, author: 'QA', body: write.body, path: 'worker.ts', kind: 'inline comment', createdAt: '2026-01-03T09:00:00Z', url: `${pr.url}#discussion_r104` })
        activePr = { ...activePr, unansweredThreads: 0, updatedAt: '2026-01-03T09:00:00Z' }
      } else {
        const entry = details.conversation.find((entry) => entry.thread?.id === write.threadId)!
        entry.thread!.isResolved = write.action === 'resolve'
        details.unresolvedThreads = details.conversation.filter((entry) => entry.thread && !entry.thread.isResolved).length
        activePr = { ...activePr, unresolvedThreads: details.unresolvedThreads, updatedAt: write.action === 'resolve' ? '2026-01-04T09:00:00Z' : '2026-01-05T09:00:00Z' }
      }
      json = { ok: true }
    }
    else if (path === '/api/prs/diff') json = { diff: { base: 'a'.repeat(40), head: activePr.headRefOid, truncated: false,
      files: [{ path: activePr.headRefOid === pr.headRefOid ? 'original.ts' : 'updated.ts', status: 'modified', additions: 1, deletions: 0, patch: activePr.headRefOid === pr.headRefOid ? '+original-diff' : '+updated-diff' }],
    } }
    else if (path === '/api/prs/threads') json = { threads: { repo: 'acme/app', number: 12, threads: [], truncated: false, fetchedAt: Date.now() } }
    else if (path === '/api/prs/conflicts') {
      conflictReads++
      json = { conflicts: cleanMerge ? { ...conflicts, state: 'clean', files: [], messages: [] } : conflicts }
    }
    await route.fulfill({ json })
  })
  await page.clock.install()
  await page.goto(`http://127.0.0.1:${port}/#token=pr-quick-look-fixture`)
  if (viewport.width === 390) await page.getByRole('button', { name: 'Open HUD', exact: true }).click()
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
  const second = page.locator('article[data-comment-id="2:102"]')
  await second.getByRole('button', { name: 'Reply', exact: true }).click()
  const composer = second.getByRole('textbox', { name: 'Reply to Reviewer on worker.ts' })
  await expect(composer).toBeFocused()
  await expect(second.getByRole('button', { name: 'Send reply' })).toBeDisabled()
  await composer.fill('**Fixed** the second finding.\n\nThanks for reviewing!')
  await page.getByRole('tab', { name: /Diff/ }).click()
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await expect(composer).toHaveValue('**Fixed** the second finding.\n\nThanks for reviewing!')
  await second.locator('form').scrollIntoViewIfNeeded()
  await expect(second.getByRole('button', { name: 'Send reply' })).toBeInViewport()
  expect(await page.locator('.pr-quick-modal').evaluate((modal) => modal.scrollWidth <= modal.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('reply-composer.png') })
  await second.getByRole('button', { name: 'Send reply' }).click()
  await expect(second.getByRole('alert')).toHaveText('Reply temporarily denied')
  await expect(composer).toHaveValue('**Fixed** the second finding.\n\nThanks for reviewing!')
  await second.getByRole('button', { name: 'Send reply' }).click()
  await expect(second.locator('article[data-comment-id="2:104"]')).toContainText('Fixed the second finding.')
  await expect(parent).not.toContainText('Fixed the second finding.')
  await expect(composer).toHaveCount(0)
  await expect(page.locator('.pr-card').getByText('2 unresolved', { exact: true })).toHaveCount(1)
  await expect(page.locator('.pr-card').getByText(/unanswered/)).toHaveCount(0)
  await second.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(second.getByText('✓ Resolved', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Conversation/ })).toContainText('1 unresolved thread')
  await expect(page.locator('.pr-card').getByText('1 unresolved', { exact: true })).toHaveCount(1)
  await second.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('resolved-thread.png') })
  await second.getByRole('button', { name: 'Reopen', exact: true }).click()
  await expect(second.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible()
  expect(writes.map((write) => write.action)).toEqual(['reply', 'reply', 'resolve', 'reopen'])
  expect(writes.every((write) => write.repo === 'acme/app' && write.number === 12 && write.threadId === 'PRRT_102')).toBe(true)
  await page.getByRole('tab', { name: /Diff/ }).click()
  await expect(page.getByText('+original-diff', { exact: true })).toBeVisible()
  activePr = { ...activePr, headRefOid: 'd'.repeat(40), baseRefOid: 'c'.repeat(40), baseRefName: 'release/final', updatedAt: '2026-01-06T09:00:00Z' }
  await page.clock.fastForward(30_000)
  await expect(page.getByText('+updated-diff', { exact: true })).toBeVisible()
  await expect(page.getByText('+original-diff', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('note')).toContainText('Merges into release/final, not main.')
  await page.getByRole('tab', { name: 'Description', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Updated description', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Checks', exact: true }).click()
  await expect(page.getByRole('link', { name: 'updated-check' })).toBeVisible()
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await expect(parent.locator('article[data-comment-id="2:103"]')).toContainText('Reply after retarget')
  await expect(page.getByText('Reply to the original finding', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Quick look at PR #12' })).toBeFocused()
  expect(errors).toEqual([])
})
}
