import { expect, test } from '@playwright/test'

const baseUrl = process.env.COMMANDO_E2E_URL ?? 'http://127.0.0.1:4312'
const token = process.env.COMMANDO_E2E_TOKEN ?? 'feature-token'

test('creates, autosaves, and reloads a Markdown block note', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.getByLabel('Create note').click()

  await page.getByLabel('Note title').fill('Browser Markdown QA')
  await expect(page.getByText('Unsaved Markdown')).toBeVisible()
  const editor = page.getByLabel('Note body')
  await editor.fill('A block note edited in Commando.')
  await expect(page.getByText('Saved to vault')).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.locator('.notes-items > button').filter({ hasText: 'Browser Markdown QA' }).first().click()
  await expect(page.getByLabel('Note title')).toHaveValue('Browser Markdown QA')
  await expect(page.getByLabel('Note body')).toContainText('A block note edited in Commando.')
  expect(errors).toEqual([])
})

test('keeps the block editor usable on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByLabel('Open session tree').click()
  await page.getByRole('button', { name: 'Notes' }).click()

  await expect(page.getByText('Markdown vault')).toBeVisible()
  if (await page.getByLabel('Note body').count() === 0) await page.getByLabel('Create note').click()
  await expect(page.getByLabel('Note body')).toBeVisible()
})

test('keeps unsupported Obsidian Markdown read-only instead of rewriting it', async ({ page, request }) => {
  const title = `Obsidian table ${Date.now()}`
  const response = await request.post(`${baseUrl}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title,
      body: '| Project | Status |\n| --- | --- |\n| Commando | Safe |',
    },
  })
  expect(response.ok()).toBe(true)

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.locator('.notes-items > button').filter({ hasText: title }).click()

  await expect(page.getByText(/cannot preserve/)).toBeVisible()
  await expect(page.getByLabel('Note body')).toHaveAttribute('contenteditable', 'false')
})
