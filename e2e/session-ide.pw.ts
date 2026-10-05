import { expect, test } from '@playwright/test'

// Run against a dedicated daemon/tmux socket with at least two sessions on the
// same checkout. The suite never sends commands into terminal panes.
const baseUrl = process.env.COMMANDO_IDE_E2E_URL
const token = process.env.COMMANDO_IDE_E2E_TOKEN ?? 'ide-poc'
test.skip(!baseUrl, 'Set COMMANDO_IDE_E2E_URL to an isolated IDE PoC stack')

test('opens one IDE per worktree, marks sessions in the sidebar and preserves the editor across navigation', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Reset only this explicitly configured isolated stack, including interrupted runs.
  const existing = await page.request.get(`${baseUrl}/api/ides`, { headers: { Authorization: `Bearer ${token}` } })
  for (const ide of (await existing.json()).ides) {
    for (const sessionId of ide.sessionIds) await page.request.delete(`${baseUrl}/api/ides/sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${token}` } })
  }
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.locator('.managed-session-main').filter({ hasText: 'TypeScript' }).click()
  await expect(page.getByRole('button', { name: 'Open IDE', exact: true }).first()).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Open IDE', exact: true }).first().click()
  const frame = page.locator('.session-ide-frame')
  await expect(frame).toBeVisible({ timeout: 40_000 })
  const editor = page.frameLocator('.session-ide-frame')
  await expect(editor.locator('.monaco-workbench')).toBeVisible({ timeout: 30_000 })
  const trust = editor.getByRole('button', { name: /Yes, I trust the authors/ })
  await trust.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await trust.isVisible()) await trust.click()
  // Git separately asks to trust the known main repository behind this test's
  // linked worktree. Trust is stored only in the isolated code-server profile.
  const parentTrust = editor.getByRole('dialog').filter({ hasText: 'Trust Folder & Continue' })
  await parentTrust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
  if (await parentTrust.isVisible()) await parentTrust.getByRole('button', { name: 'Trust Folder & Continue', exact: true }).click()
  const secondarySidebar = editor.getByRole('button', { name: /Toggle Secondary Side Bar/ })
  if (await secondarySidebar.getAttribute('aria-pressed') === 'true') await secondarySidebar.click()
  const workspaceName = new URL((await frame.getAttribute('src'))!, baseUrl).searchParams.get('folder')!.split('/').at(-1)!
  await editor.getByRole('button', { name: workspaceName, exact: true }).click()
  const quickOpen = editor.locator('.quick-input-box input')
  await quickOpen.fill('src/ide-fixture.ts')
  await expect(editor.locator('.quick-input-list')).toContainText('ide-fixture.ts')
  await quickOpen.press('Enter')
  await expect(editor.getByRole('tab', { name: /ide-fixture.ts/ })).toBeVisible()
  await expect(editor.locator('.monaco-editor .view-lines').first()).toContainText('createSessionIdesApi')
  const input = editor.getByRole('textbox', { name: 'ide-fixture.ts', exact: true })
  const revertBuffer = async () => {
    await input.press('F1')
    await quickOpen.fill('>File: Revert File')
    await expect(editor.locator('.quick-input-list')).toContainText('Revert File')
    await editor.getByRole('option').filter({ hasText: /^File: Revert File/ }).click()
    await expect(editor.locator('.monaco-editor .view-lines').first()).not.toContainText('unsaved IDE PoC buffer')
  }
  await revertBuffer()
  await input.press('Meta+ArrowUp')
  await input.pressSequentially('// unsaved IDE PoC buffer\n', { delay: 5 })
  await expect(editor.locator('.monaco-editor .view-lines').first()).toContainText('unsaved IDE PoC buffer')
  await expect(page.getByRole('button', { name: /Open attached IDE for/ })).toHaveCount(1)

  // Node identity, not just URL equality: an iframe remount loses dirty buffers.
  await frame.evaluate((element) => element.setAttribute('data-poc-retained', 'yes'))
  await page.getByRole('button', { name: 'Minimize IDE', exact: true }).click()
  await expect(frame).toBeHidden()
  await page.getByRole('button', { name: /Open attached IDE for/ }).click()
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('data-poc-retained', 'yes')
  await expect(editor.locator('.monaco-editor .view-lines').first()).toContainText('unsaved IDE PoC buffer')

  // Attach the other session via its sidebar menu: same worktree, same iframe/process.
  await page.getByRole('button', { name: 'Open IDE for Shared-worktree', exact: true }).click()
  await expect(page.getByRole('button', { name: /Open attached IDE for/ })).toHaveCount(2)
  await expect(frame).toHaveCount(1)
  await expect(frame).toHaveAttribute('data-poc-retained', 'yes')
  await expect(page.getByText(/shared by 2 sessions/)).toBeVisible()
  await revertBuffer()
  const attachments = await page.evaluate(async (auth) => {
    const response = await fetch('/api/ides', { headers: { Authorization: `Bearer ${auth}` } })
    return response.json() as Promise<{ ides: Array<{ id: string; sessionIds: string[]; url: string }> }>
  }, token)
  expect(attachments.ides).toHaveLength(1)
  expect(attachments.ides[0].sessionIds).toHaveLength(2)
  const unauthenticated = await page.request.get(new URL(attachments.ides[0].url, baseUrl).toString(), { headers: { Cookie: '' } })
  expect(unauthenticated.status()).toBe(401)

  await page.setViewportSize({ width: 1000, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/session-ide.png', fullPage: true })
  await page.setViewportSize({ width: 756, height: 469 })
  expect(await frame.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(700)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  expect(errors).toEqual([])

  const nativeDialogs: string[] = []
  // Match an embedded renderer where native confirmation dialogs are dismissed.
  page.on('dialog', (dialog) => { nativeDialogs.push(dialog.type()); void dialog.dismiss() })
  await page.getByRole('button', { name: 'Detach IDE', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Confirm IDE detachment' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: /Open attached IDE for/ })).toHaveCount(2)
  await page.getByRole('button', { name: 'Detach IDE', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm detach', exact: true }).click()
  await expect(page.getByRole('button', { name: /Open attached IDE for/ })).toHaveCount(1)
  await page.getByRole('button', { name: /Open attached IDE for/ }).click()
  await expect(frame).toBeVisible()
  await page.getByRole('button', { name: 'Detach IDE', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Confirm IDE detachment' })).toContainText('Save your files first')
  await page.getByRole('button', { name: 'Confirm detach', exact: true }).click()
  await expect(page.getByRole('button', { name: /Open attached IDE for/ })).toHaveCount(0)
  await expect(frame).toHaveCount(0)
  expect(nativeDialogs).toEqual([])
})
