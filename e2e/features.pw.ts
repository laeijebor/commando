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

  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByText('Markdown vault')).toBeVisible()
  await expect(page.getByText('QA note')).toBeVisible()
  await expect(page.getByLabel('Note body')).toContainText('Autosave-ready local note')

  await page.getByRole('button', { name: 'Linear' }).click()
  await expect(page.getByRole('heading', { name: 'Linear projects' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect a Linear account' })).toBeVisible()
  await expect(page.getByPlaceholder('Linear API key')).toBeVisible()

  expect(errors).toEqual([])
})

test('popped-out note stays visible across areas and can move and resize', async ({ page }) => {
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByLabel('Note body')).toBeVisible()
  await page.getByRole('button', { name: 'Pop out note' }).click()

  const noteWindow = page.getByRole('dialog', { name: /Popped-out note:/ })
  const initial = await noteWindow.boundingBox()
  expect(initial).not.toBeNull()

  const bar = noteWindow.locator('.notes-window-bar')
  const barBounds = await bar.boundingBox()
  expect(barBounds).not.toBeNull()
  await page.mouse.move(barBounds!.x + 80, barBounds!.y + barBounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(barBounds!.x + 30, barBounds!.y + barBounds!.height / 2 + 24, { steps: 4 })
  await page.mouse.up()

  const resizeHandle = noteWindow.getByRole('separator', { name: 'Resize popped-out note' })
  const resizeBounds = await resizeHandle.boundingBox()
  expect(resizeBounds).not.toBeNull()
  await page.mouse.move(resizeBounds!.x + 10, resizeBounds!.y + 10)
  await page.mouse.down()
  await page.mouse.move(resizeBounds!.x - 30, resizeBounds!.y - 30, { steps: 4 })
  await page.mouse.up()

  const changed = await noteWindow.boundingBox()
  expect(changed!.x).toBeLessThan(initial!.x - 40)
  expect(changed!.y).toBeGreaterThan(initial!.y + 15)
  expect(changed!.width).toBeLessThan(initial!.width - 30)
  expect(changed!.height).toBeLessThan(initial!.height - 30)

  const areaNavigation = page.getByRole('navigation', { name: 'Commando areas' })
  const workspaceButton = areaNavigation.getByRole('button').filter({ hasText: 'Workspace' })
  await workspaceButton.click()
  await expect(noteWindow).toBeVisible()
  await expect(workspaceButton).toHaveAttribute('aria-current', 'page')
  await areaNavigation.getByRole('button', { name: 'Linear', exact: true }).click()
  await expect(noteWindow).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Linear projects' })).toBeVisible()
  await noteWindow.getByRole('button', { name: 'Dock note' }).click()
  await expect(noteWindow).not.toBeVisible()
})

test('notes section remains usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByLabel('Open session tree').click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByText('Markdown vault')).toBeVisible()
  await expect(page.getByLabel('Note body')).toBeVisible()
})

test('popped-out note remains contained at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  await page.getByLabel('Open session tree').click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: 'Pop out note' }).click()

  const noteWindow = page.getByRole('dialog', { name: /Popped-out note:/ })
  await expect(noteWindow).toBeVisible()
  const bounds = await noteWindow.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(44)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)

  await page.getByLabel('Open session tree').click()
  await page.getByRole('button', { name: 'Linear', exact: true }).click()
  await expect(noteWindow).toBeVisible()
  await noteWindow.getByRole('button', { name: 'Dock note' }).click()
  await expect(noteWindow).not.toBeVisible()
})

test('adjacent panes resize by width and height and persist locally', async ({ page }) => {
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  const group = page.locator('.pane-group').first()
  const widthSplitters = group.getByRole('separator', { name: 'Resize pane widths' })
  const direction = await widthSplitters.count() > 0 ? 'width' : 'height'
  const splitter = direction === 'width'
    ? widthSplitters.first()
    : group.getByRole('separator', { name: 'Resize pane heights' }).first()
  const initial = await splitter.evaluate((element, axis) => {
    const before = element.previousElementSibling?.getBoundingClientRect()
    const after = element.nextElementSibling?.getBoundingClientRect()
    return before && after
      ? { before: axis === 'width' ? before.width : before.height, after: axis === 'width' ? after.width : after.height }
      : null
  }, direction)
  expect(initial).not.toBeNull()

  const splitterBounds = await splitter.boundingBox()
  expect(splitterBounds).not.toBeNull()
  const centerX = splitterBounds!.x + splitterBounds!.width / 2
  const centerY = splitterBounds!.y + splitterBounds!.height / 2
  await page.mouse.move(centerX, centerY)
  await page.mouse.down()
  await page.mouse.move(
    direction === 'width' ? centerX - 32 : centerX,
    direction === 'height' ? centerY - 32 : centerY,
    { steps: 4 },
  )
  await page.mouse.up()

  const resized = await splitter.evaluate((element, axis) => {
    const before = element.previousElementSibling?.getBoundingClientRect()
    const after = element.nextElementSibling?.getBoundingClientRect()
    return before && after
      ? { before: axis === 'width' ? before.width : before.height, after: axis === 'width' ? after.width : after.height }
      : null
  }, direction)
  expect(resized!.before).toBeLessThanOrEqual(initial!.before - 24)
  expect(resized!.after).toBeGreaterThanOrEqual(initial!.after + 24)

  await page.reload()
  const persistedGroup = page.locator('.pane-group').first()
  const persistedSplitter = direction === 'width'
    ? persistedGroup.getByRole('separator', { name: 'Resize pane widths' }).first()
    : persistedGroup.getByRole('separator', { name: 'Resize pane heights' }).first()
  const persisted = await persistedSplitter.evaluate((element, axis) => {
    const before = element.previousElementSibling?.getBoundingClientRect()
    const after = element.nextElementSibling?.getBoundingClientRect()
    return before && after
      ? { before: axis === 'width' ? before.width : before.height, after: axis === 'width' ? after.width : after.height }
      : null
  }, direction)
  expect(persisted?.before).toBeCloseTo(resized!.before, 0)
  expect(persisted?.after).toBeCloseTo(resized!.after, 0)
})

test('pane groups resize from their outer right, bottom, and corner handles', async ({ page }) => {
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`)
  const group = page.locator('.pane-group').first()
  const initial = await group.boundingBox()
  expect(initial).not.toBeNull()

  const right = group.getByRole('separator', { name: 'Resize workspace width', exact: true })
  const rightBounds = await right.boundingBox()
  expect(rightBounds).not.toBeNull()
  await page.mouse.move(rightBounds!.x + 4, rightBounds!.y + rightBounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(rightBounds!.x - 92, rightBounds!.y + rightBounds!.height / 2, { steps: 5 })
  await page.mouse.up()

  const bottom = group.getByRole('separator', { name: 'Resize workspace height', exact: true })
  const bottomBounds = await bottom.boundingBox()
  expect(bottomBounds).not.toBeNull()
  await page.mouse.move(bottomBounds!.x + bottomBounds!.width / 2, bottomBounds!.y + 4)
  await page.mouse.down()
  await page.mouse.move(bottomBounds!.x + bottomBounds!.width / 2, bottomBounds!.y + 84, { steps: 5 })
  await page.mouse.up()

  const corner = group.getByRole('separator', { name: 'Resize workspace width and height' })
  const cornerBounds = await corner.boundingBox()
  expect(cornerBounds).not.toBeNull()
  await page.mouse.move(cornerBounds!.x + 5, cornerBounds!.y + 5)
  await page.mouse.down()
  await page.mouse.move(cornerBounds!.x + 45, cornerBounds!.y + 45, { steps: 4 })
  await page.mouse.up()

  const resized = await group.boundingBox()
  expect(resized!.width).toBeLessThan(initial!.width - 40)
  expect(resized!.height).toBeGreaterThan(initial!.height + 80)

  await page.waitForTimeout(300)
  await page.reload()
  const persisted = await page.locator('.pane-group').first().boundingBox()
  expect(persisted?.width).toBeCloseTo(resized!.width, 0)
  expect(persisted?.height).toBeCloseTo(resized!.height, 0)
})
