import { expect, test } from '@playwright/test'
import type { PrSummary } from '../src/prsApi'

const baseUrl = process.env.COMMANDO_E2E_URL ?? 'http://127.0.0.1:4428'
const token = process.env.COMMANDO_E2E_TOKEN ?? 'stacks-qa'
const repo = 'acme/widgets'
function pr(number: number, head: string, base: string, position: number): PrSummary {
  return { number, title: number === 10 ? 'Model layer' : 'API layer', url: `https://github.com/${repo}/pull/${number}`,
    state: 'open', isDraft: false, author: 'leo', bodyExcerpt: 'A reviewable layer', additions: 20, deletions: 2, changedFiles: 1, commitCount: 1,
    unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [], conflicting: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: null, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z',
    headRefName: head, baseRefName: base, headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), viewerIsAuthor: true,
    viewerReviewRequested: false, commandoMarker: null, stack: { number: 7, position, size: 2, baseRefName: 'main' } }
}
const prs = [pr(10, 'models', 'main', 1), pr(20, 'api', 'models', 2)]
const stack = { number: 7, open: true, baseRefName: 'main', pullRequests: prs.map((pr) => ({ number: pr.number, headRefName: pr.headRefName, url: pr.url, state: pr.state, isDraft: pr.isDraft })) }

test('native stack navigation and creation preserve the branch chain and partial success', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const writes: unknown[] = []
  // Fixture only the PR API; the built app, daemon, and isolated tmux session are real.
  // Production GitHub is never mutated by this regression.
  await page.route('**/api/prs{,/**,?*}', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.slice('/api/prs'.length)
    let data: unknown
    if (path === '/prefs') data = { prefs: { version: 1, pinnedRepos: [repo], recentRepos: [repo], lastRepo: repo, lastFilter: 'open', lastScope: 'mine' } }
    else if (path === '/repos') data = { repos: [{ nameWithOwner: repo, pinned: true }] }
    else if (path === '/repo') data = { repo }
    else if (path === '/pane') data = { list: { targetId: 'test', totalCount: 0, pullRequests: [], truncated: false, fetchedAt: Date.now() } }
    else if (path === '/details') data = { details: { body: 'A reviewable layer', conversation: [], checks: [], headOid: 'a'.repeat(40), mergeTarget: { branch: url.searchParams.get('number') === '20' ? 'models' : 'main', oid: 'b'.repeat(40) } } }
    else if (path === '/stack') {
      if (request.method() === 'POST') writes.push(request.postDataJSON())
      data = { stack }
    } else if (path === '/stacked-pr') {
      writes.push(request.postDataJSON())
      data = { pullRequest: { number: 30, url: `https://github.com/${repo}/pull/30` }, stack: null, warning: 'PR #30 was created, but stack linking could not be confirmed. Use Link existing PRs (10, 20, 30).' }
    } else data = { list: { repo, filter: 'open', viewer: 'leo', pullRequests: prs, totalCount: 2, mineTruncated: false, truncated: false, fetchedAt: Date.now() } }
    await route.fulfill({ json: data })
  })
  await page.goto(`${baseUrl}/#token=${token}`)
  await page.getByRole('tab', { name: 'PRs', exact: true }).click()
  await expect(page.getByText('stack #7 · 2/2')).toBeVisible()
  await page.getByRole('button', { name: 'Quick look at PR #20' }).click()
  await page.getByRole('tab', { name: 'Stack', exact: true }).click()
  await expect(page.getByRole('link', { name: '#10 models' })).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toContainText('#20')
  await page.screenshot({ path: testInfo.outputPath('stack-navigation.png'), fullPage: true })
  await page.getByRole('button', { name: 'Close PR quick look' }).click()
  await page.getByRole('button', { name: 'Create stack', exact: true }).click()
  await page.getByLabel('PR numbers · bottom to top').fill('10, 20')
  await page.getByRole('button', { name: 'Link stack on GitHub' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Stack #7 saved' })).toBeVisible()
  expect(writes[0]).toEqual({ repo, numbers: [10, 20] })
  await page.getByRole('region', { name: 'Create a native GitHub stack' }).getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Create stack', exact: true }).click()
  await page.getByRole('button', { name: 'New PR on top' }).click()
  await page.getByLabel('Parent PR').selectOption('20')
  await page.getByLabel('Already-pushed branch').fill('ui')
  await page.getByLabel('Title', { exact: true }).fill('UI layer')
  await page.getByLabel('Description', { exact: true }).fill('Adds the UI above the API layer.')
  await page.screenshot({ path: testInfo.outputPath('stacked-pr-form.png'), fullPage: true })
  await page.getByRole('button', { name: 'Create stacked PR', exact: true }).click()
  await expect(page.getByRole('link', { name: 'PR #30 created' })).toBeVisible()
  await expect(page.getByText(/PR #30 was created, but/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create stacked PR', exact: true })).toHaveCount(0)
  expect(writes[1]).toMatchObject({ repo, parentNumber: 20, head: 'ui', title: 'UI layer', body: 'Adds the UI above the API layer.', draft: true })
  await page.screenshot({ path: testInfo.outputPath('partial-success.png'), fullPage: true })
  expect(errors).toEqual([])
})
