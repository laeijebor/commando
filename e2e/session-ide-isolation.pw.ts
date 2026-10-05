import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const baseUrl = process.env.COMMANDO_IDE_ISOLATION_E2E_URL
const token = process.env.COMMANDO_IDE_ISOLATION_E2E_TOKEN ?? 'ide-isolation'
test.skip(!baseUrl, 'Set COMMANDO_IDE_ISOLATION_E2E_URL to a disposable two-worktree stack')

async function acceptWorkspaceTrust(editor: FrameLocator) {
  await expect(editor.locator('.monaco-workbench')).toBeVisible({ timeout: 30_000 })
  const trust = editor.getByRole('button', { name: /Yes, I trust the authors/ })
  await trust.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await trust.isVisible()) await trust.click()
  const parentTrust = editor.getByRole('button', { name: 'Trust Folder & Continue', exact: true })
  await parentTrust.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await parentTrust.isVisible()) await parentTrust.click()
}

async function command(editor: FrameLocator, title: string) {
  await editor.locator('.monaco-workbench').press('F1')
  const input = editor.locator('.quick-input-box input')
  await input.fill(`>${title}`)
  await editor.getByRole('option').filter({ hasText: title }).first().click()
}

async function openFile(editor: FrameLocator, workspace: string, file: string) {
  await editor.getByRole('button', { name: workspace, exact: true }).click()
  await editor.locator('.quick-input-box input').fill(`ide-fixtures/${file}`)
  await editor.locator('.quick-input-list').getByText(file, { exact: true }).first().click()
  await expect(editor.getByRole('tab', { name: new RegExp(file.replace('.', '\\.')) })).toBeVisible()
}

async function extensionsSearch(editor: FrameLocator) {
  await editor.getByRole('tab', { name: /^Extensions/ }).click()
  const search = editor.getByRole('textbox', { name: 'Search Extensions in Marketplace' })
  await search.press('Meta+a')
  await search.pressSequentially('@id:dracula-theme.theme-dracula', { delay: 5 })
  await expect(editor.getByText('Dracula Theme Official', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function ideList(page: Page) {
  return page.evaluate(async (auth) => {
    const response = await fetch('/api/ides', { headers: { Authorization: `Bearer ${auth}` } })
    return response.json() as Promise<{ ides: Array<{ id: string; workspacePath: string; sessionIds: string[] }> }>
  }, token)
}

test('different Git worktrees isolate folders, tabs, settings and installed extensions', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: /^Open (attached )?IDE for Worktree-A$/ }).click()
  const frameA = page.locator('.session-ide-frame[src*="worktree-a"]')
  const editorA = page.frameLocator('.session-ide-frame[src*="worktree-a"]')
  await expect(frameA).toBeVisible({ timeout: 40_000 })
  await acceptWorkspaceTrust(editorA)
  await openFile(editorA, 'worktree-a', 'a-only.ts')
  await expect(editorA.getByRole('main').locator('.monaco-editor .view-lines').first()).toContainText('WORKTREE_A')
  await frameA.evaluate((element) => element.setAttribute('data-worktree-context', 'A'))

  // Customize user settings through the editor, just as a user would.
  await command(editorA, 'Preferences: Open Settings (UI)')
  const settingsSearch = editorA.getByRole('textbox', { name: /Search settings/i })
  await settingsSearch.press('Meta+a')
  await settingsSearch.pressSequentially('@id:editor.fontSize', { delay: 5 })
  await editorA.getByRole('spinbutton', { name: 'editor.fontSize', exact: true }).fill('22')
  await editorA.getByRole('spinbutton', { name: 'editor.fontSize', exact: true }).press('Tab')
  await openFile(editorA, 'worktree-a', 'a-only.ts')
  await expect.poll(() => editorA.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('22px')

  // Install a real Open VSX extension through the normal Extensions view.
  await extensionsSearch(editorA)
  const install = editorA.getByRole('button', { name: /^Install(?: Dracula Theme Official)?$/ }).first()
  if (await install.isVisible()) {
    await install.click()
    const trustPublisher = editorA.getByRole('button', { name: /Trust.*Install/ })
    await trustPublisher.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined)
    if (await trustPublisher.isVisible()) await trustPublisher.click()
  }
  await expect(editorA.getByRole('listitem', { name: /^Dracula Theme Official/ }).getByRole('button', { name: 'Manage', exact: true })).toBeVisible({ timeout: 60_000 })
  await command(editorA, 'Preferences: Color Theme')
  await editorA.getByRole('option', { name: 'Dracula Theme', exact: true }).click()
  await openFile(editorA, 'worktree-a', 'a-only.ts')

  await page.getByRole('button', { name: /^Open (attached )?IDE for Worktree-B$/ }).click()
  const frameB = page.locator('.session-ide-frame[src*="worktree-b"]')
  const editorB = page.frameLocator('.session-ide-frame[src*="worktree-b"]')
  await expect(frameB).toBeVisible({ timeout: 40_000 })
  await expect(frameA).toBeHidden()
  await acceptWorkspaceTrust(editorB)
  await expect(editorB.getByRole('tab', { name: /a-only\.ts|settings\.json/ })).toHaveCount(0)
  await openFile(editorB, 'worktree-b', 'b-only.ts')
  await expect(editorB.getByRole('main').locator('.monaco-editor .view-lines').first()).toContainText('WORKTREE_B')
  await expect.poll(() => editorB.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).not.toBe('22px')
  await extensionsSearch(editorB)
  await expect(editorB.getByRole('button', { name: /^Install(?: Dracula Theme Official)?$/ }).first()).toBeVisible()
  await page.screenshot({ path: '.screenshots/worktree-ide-isolation/worktree-b.png', fullPage: true })

  const { ides } = await ideList(page)
  expect(ides).toHaveLength(2)
  expect(new Set(ides.map((ide) => ide.id)).size).toBe(2)
  expect(ides.map((ide) => ide.workspacePath.split('/').at(-1)).sort()).toEqual(['worktree-a', 'worktree-b'])
  expect(ides.every((ide) => ide.sessionIds.length === 1)).toBe(true)
  await expect(page.locator('.session-ide-frame')).toHaveCount(2)

  await page.getByRole('button', { name: 'Open attached IDE for Worktree-A', exact: true }).click()
  await expect(frameA).toBeVisible()
  await expect(frameB).toBeHidden()
  await expect(frameA).toHaveAttribute('data-worktree-context', 'A')
  await expect(editorA.getByRole('tab', { name: /a-only\.ts/ })).toBeVisible()
  await expect(editorA.getByRole('tab', { name: /b-only\.ts/ })).toHaveCount(0)
  await expect.poll(() => editorA.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('22px')
  await page.screenshot({ path: '.screenshots/worktree-ide-isolation/worktree-a.png', fullPage: true })
})
