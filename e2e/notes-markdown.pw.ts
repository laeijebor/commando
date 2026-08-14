import { expect, test, type APIRequestContext } from '@playwright/test'

const baseUrl = process.env.COMMANDO_E2E_URL ?? 'http://127.0.0.1:4312'
const token = process.env.COMMANDO_E2E_TOKEN ?? 'feature-token'
const authorization = { Authorization: `Bearer ${token}` }

async function getActiveVaultId(request: APIRequestContext) {
  const vaultResponse = await request.get(`${baseUrl}/api/note-vaults`, { headers: authorization })
  expect(vaultResponse.ok()).toBe(true)
  const { activeVaultId } = await vaultResponse.json() as { activeVaultId: string }
  return activeVaultId
}

async function createNote(request: APIRequestContext, title: string, body: string) {
  const activeVaultId = await getActiveVaultId(request)
  return request.post(`${baseUrl}/api/notes?vault=${encodeURIComponent(activeVaultId)}`, {
    headers: authorization,
    data: { title, body },
  })
}

test('creates, autosaves, and reloads a Markdown block note', async ({ page, request }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  const notes = page.locator('.notes-items > button')
  const vaultId = await getActiveVaultId(request)
  const notesResponse = await request.get(
    `${baseUrl}/api/notes?vault=${encodeURIComponent(vaultId)}`,
    { headers: authorization },
  )
  expect(notesResponse.ok()).toBe(true)
  const snapshot = await notesResponse.json() as { notes: unknown[] }
  await expect(notes).toHaveCount(snapshot.notes.length)
  await page.getByLabel('Create note').click()
  await expect(notes).toHaveCount(snapshot.notes.length + 1)

  await page.getByLabel('Note title').fill('Browser Markdown QA')
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

test('keeps semantically equivalent Markdown editable', async ({ page, request }) => {
  const title = `Canonical Markdown ${Date.now()}`
  const response = await createNote(
    request,
    title,
    'Paragraph before a list\n- [x] Hyphen task marker\n\n- [ ] Blank line within the list\n\n* Separate bullet group',
  )
  expect(response.ok()).toBe(true)

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.locator('.notes-items > button').filter({ hasText: title }).click()

  await expect(page.getByLabel('Note body')).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByText(/cannot preserve/)).toHaveCount(0)
})

test('keeps GFM tables editable', async ({ page, request }) => {
  const title = `Obsidian table ${Date.now()}`
  const response = await createNote(
    request,
    title,
    '| Project | Status |\n| --- | --- |\n| Commando | Safe |',
  )
  expect(response.ok()).toBe(true)

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.locator('.notes-items > button').filter({ hasText: title }).click()

  await expect(page.getByText(/cannot preserve/)).toHaveCount(0)
  await expect(page.getByLabel('Note body')).toHaveAttribute('contenteditable', 'true')
})

test('keeps soft-wrapped Markdown editable', async ({ page, request }) => {
  const title = `Soft-wrapped Markdown ${Date.now()}`
  const response = await createNote(
    request,
    title,
    'Live\nLive ops\nBelts\nConsistent share mechanism',
  )
  expect(response.ok()).toBe(true)

  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes' }).click()
  await page.locator('.notes-items > button').filter({ hasText: title }).click()

  await expect(page.getByText(/cannot preserve/)).toHaveCount(0)
  await expect(page.getByLabel('Note body')).toHaveAttribute('contenteditable', 'true')
})
