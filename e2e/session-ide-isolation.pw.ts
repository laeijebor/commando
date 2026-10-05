import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const baseUrl = process.env.COMMANDO_IDE_ISOLATION_E2E_URL
const token = process.env.COMMANDO_IDE_ISOLATION_E2E_TOKEN ?? 'ide-isolation'
const screenshots = process.env.COMMANDO_IDE_E2E_SCREENSHOT_DIR ?? '.screenshots/worktree-ide-isolation'
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
  // A focusable control puts keyboard focus back inside the selected iframe.
  const explorer = editor.getByRole('tab', { name: /^Explorer/ })
  await explorer.click()
  await explorer.press('F1')
  const input = editor.locator('.quick-input-box input')
  await input.fill(`>${title}`)
  await editor.getByRole('option').filter({ hasText: title }).first().click()
}

async function openFile(editor: FrameLocator, _workspace: string, file: string) {
  const explorer = editor.getByRole('tab', { name: /^Explorer/ })
  await explorer.click()
  await explorer.press('Meta+p')
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

test('different Git worktrees isolate folders and tabs while sharing settings and installed extensions', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: /^Open (attached )?IDE for Worktree-A$/ }).click()
  const frameA = page.locator('.session-ide-frame[src*="worktree-a"]')
  const editorA = page.frameLocator('.session-ide-frame[src*="worktree-a"]')
  await expect(frameA).toBeVisible({ timeout: 40_000 })
  await acceptWorkspaceTrust(editorA)
  await openFile(editorA, 'worktree-a', 'a-only.ts')
  await expect(editorA.getByRole('main').locator('.monaco-editor .view-lines').first()).toContainText('WORKTREE_A')
  if (process.env.COMMANDO_IDE_SHARED_MIGRATION_E2E) {
    await expect.poll(() => editorA.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('19px')
    await expect.poll(() => editorA.locator('.monaco-workbench').evaluate((element) => getComputedStyle(element).getPropertyValue('--vscode-editor-background').trim().toLowerCase())).toBe('#151515')
    await editorA.locator('.monaco-workbench').press('Control+Alt+9')
    await expect(editorA.getByRole('tab', { name: /Untitled-1/ })).toBeVisible()
    await openFile(editorA, 'worktree-a', 'a-only.ts')
  }
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
  await expect(editorB.getByRole('tab', { name: /a-only\.ts|settings\.json|Untitled-1/ })).toHaveCount(0)
  await openFile(editorB, 'worktree-b', 'b-only.ts')
  await expect(editorB.getByRole('main').locator('.monaco-editor .view-lines').first()).toContainText('WORKTREE_B')
  await expect.poll(() => editorB.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('22px')
  await expect.poll(() => editorB.locator('.monaco-workbench').evaluate((element) => getComputedStyle(element).getPropertyValue('--vscode-editor-background').trim().toLowerCase())).toBe('#282a36')
  await extensionsSearch(editorB)
  await expect(editorB.getByRole('listitem', { name: /^Dracula Theme Official/ }).getByRole('button', { name: 'Manage', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${screenshots}/worktree-b.png`, fullPage: true })

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
  await page.screenshot({ path: `${screenshots}/worktree-a.png`, fullPage: true })

  // User configuration is browser-cached. A deliberate workbench reload picks
  // up another worktree's changes; never force a reload over a dirty editor.
  await command(editorA, 'Preferences: Open Settings (UI)')
  await editorA.getByRole('textbox', { name: /Search settings/i }).press('Meta+a')
  await editorA.getByRole('textbox', { name: /Search settings/i }).pressSequentially('@id:editor.fontSize', { delay: 5 })
  await editorA.getByRole('spinbutton', { name: 'editor.fontSize', exact: true }).fill('24')
  await editorA.getByRole('spinbutton', { name: 'editor.fontSize', exact: true }).press('Tab')
  await openFile(editorA, 'worktree-a', 'a-only.ts')
  await expect.poll(() => editorA.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('24px')
  await page.getByRole('button', { name: 'Open attached IDE for Worktree-B', exact: true }).click()
  await command(editorB, 'Developer: Reload Window')
  await acceptWorkspaceTrust(editorB)
  await openFile(editorB, 'worktree-b', 'b-only.ts')
  await expect.poll(() => editorB.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('24px')

  // Removing every attachment shuts down the backend. New workbenches inherit
  // the same disk profile, without inheriting the other folder's tabs.
  for (const name of ['Worktree-B', 'Worktree-A']) {
    await page.getByRole('button', { name: `Open attached IDE for ${name}`, exact: true }).click()
    await page.getByRole('button', { name: 'Detach IDE', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm detach', exact: true }).click()
  }
  await expect(page.locator('.session-ide-frame')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open IDE for Worktree-B', exact: true }).click()
  await acceptWorkspaceTrust(editorB)
  await openFile(editorB, 'worktree-b', 'b-only.ts')
  await expect.poll(() => editorB.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('24px')
  await expect(editorB.getByRole('tab', { name: /a-only\.ts/ })).toHaveCount(0)
  await extensionsSearch(editorB)
  await expect(editorB.getByRole('listitem', { name: /^Dracula Theme Official/ }).getByRole('button', { name: 'Manage', exact: true })).toBeVisible({ timeout: 30_000 })

  if (process.env.COMMANDO_IDE_SHARED_MIGRATION_E2E) {
    await page.getByRole('button', { name: 'Open IDE for Worktree-C', exact: true }).click()
    const editorC = page.frameLocator('.session-ide-frame[src*="worktree-c"]')
    await acceptWorkspaceTrust(editorC)
    await openFile(editorC, 'worktree-c', 'c-only.ts')
    await expect.poll(() => editorC.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('18px')
    await expect(editorC.getByRole('tab', { name: /a-only\.ts|b-only\.ts/ })).toHaveCount(0)
    await extensionsSearch(editorC)
    await expect(editorC.getByRole('listitem', { name: /^Dracula Theme Official/ }).getByRole('button', { name: 'Manage', exact: true })).toBeVisible({ timeout: 30_000 })
  }
})

test('shared preferences, keybindings and extensions survive a Commando daemon restart', async ({ page }) => {
  test.skip(!process.env.COMMANDO_IDE_SHARED_RESTART_E2E, 'Run after the sharing test and restart the disposable daemon with the same profile')
  test.setTimeout(90_000)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Open IDE for Worktree-B', exact: true }).click()
  const editor = page.frameLocator('.session-ide-frame[src*="worktree-b"]')
  await acceptWorkspaceTrust(editor)
  await openFile(editor, 'worktree-b', 'b-only.ts')
  await expect.poll(() => editor.getByRole('main').locator('.monaco-editor .view-lines').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('24px')
  await expect.poll(() => editor.locator('.monaco-workbench').evaluate((element) => getComputedStyle(element).getPropertyValue('--vscode-editor-background').trim().toLowerCase())).toBe('#282a36')
  await expect(editor.getByRole('tab', { name: /a-only\.ts|c-only\.ts/ })).toHaveCount(0)
  await editor.locator('.monaco-workbench').press('Control+Alt+9')
  await expect(editor.getByRole('tab', { name: /Untitled-1/ })).toBeVisible()
  await extensionsSearch(editor)
  await expect(editor.getByRole('listitem', { name: /^Dracula Theme Official/ }).getByRole('button', { name: 'Manage', exact: true })).toBeVisible({ timeout: 30_000 })
})
