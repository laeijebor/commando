import { expect, test } from '@playwright/test'

const baseUrl = process.env.COMMANDO_E2E_URL ?? 'http://127.0.0.1:4312'
const token = process.env.COMMANDO_E2E_TOKEN ?? 'feature-token'

test('navigates the new local cockpit sections without browser errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await expect(page.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('QA Group')).toBeVisible()
  await expect(page.getByText('renamed-from-commando')).toBeVisible()
  await expect(page.getByText('New tmux target')).toBeVisible()
  await expect(page.locator('.managed-session-tree [aria-label^="Move "]')).toHaveCount(0)
  await expect(page.locator('.managed-session-main strong').first()).toHaveCSS('font-size', '10px')
  await page.getByText('New tmux target').click()
  const createPanelContained = await page.evaluate(() => {
    const sidebar = document.querySelector('.session-tree')?.getBoundingClientRect()
    const panel = document.querySelector('.tmux-create__panel')?.getBoundingClientRect()
    return Boolean(sidebar && panel && panel.left >= sidebar.left && panel.right <= sidebar.right)
  })
  expect(createPanelContained).toBe(true)

  await page.getByText('renamed-from-commando').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete session' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Notes' }).click()
  await expect(page.getByText('Local notebook')).toBeVisible()
  await expect(page.getByText('QA note')).toBeVisible()
  await expect(page.getByLabel('Note body')).toHaveValue('Autosave-ready local note')

  await page.getByRole('button', { name: 'Linear' }).click()
  await expect(page.getByRole('heading', { name: 'Linear projects' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect a Linear account' })).toBeVisible()
  await expect(page.getByPlaceholder('Linear API key')).toBeVisible()

  expect(errors).toEqual([])
})

test('notes section remains usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByLabel('Open session tree').click()
  await page.getByRole('button', { name: 'Notes' }).click()
  await expect(page.getByText('Local notebook')).toBeVisible()
  await expect(page.getByLabel('Note body')).toBeVisible()
})
