import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

// Run: npx playwright test --config=e2e/redline-feedback.config.ts
const sdk = readFileSync(new URL('../server/static/redline-sdk.js', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../server/static/redline-default.css', import.meta.url), 'utf8')
const reviewedDocument = readFileSync(new URL('./fixtures/redline-sections.html', import.meta.url), 'utf8')
const fixtureHtml = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/src/web-pane.css?direct">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #11151b; color: #eef0f7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :root { --mono: ui-monospace, monospace; --bg: #11151b; --surface: #1c232d; --text: #eef0f7; --accent: #b5a8ff; --border: #374252; }
  #review-toggle { height: 40px; }
</style>
<script type="module">
  import RefreshRuntime from '/@react-refresh';
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => type => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module" src="/e2e/fixtures/redline-feedback.tsx"></script>
</head><body><div id="root"></div></body></html>`

const strip = (page: Page) => page.getByTestId('pending-queue-strip')
const drawer = (page: Page) => page.getByTestId('pending-queue-drawer')
const documentFrame = (page: Page) => page.frameLocator('iframe[title="Reviewed document"]')
const queuedSnapshot = (page: Page) => page.evaluate(() => (window as any).feedbackFixture.getSnapshot())

async function openQueue(page: Page) {
  await strip(page).getByRole('button', { name: /Answer queue/ }).click()
  await expect(drawer(page)).toBeVisible()
}

async function assertSummaryAndBounds(page: Page) {
  await expect(strip(page)).toBeInViewport()
  await expect(strip(page).getByRole('button', { name: 'Send all', exact: true })).toBeInViewport()
  await expect(strip(page).getByRole('button', { name: 'Send all + Build', exact: true })).toBeInViewport()
  await expect.poll(async () => {
    const sheet = await drawer(page).boundingBox()
    const summary = await strip(page).boundingBox()
    return Boolean(sheet && summary && sheet.y >= 0 && sheet.x >= 0 &&
      sheet.y + sheet.height <= summary.y && sheet.x + sheet.width <= page.viewportSize()!.width)
  }).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect.poll(() => page.locator('.web-pane-native-slot').evaluate(element =>
    Number.parseFloat((element as HTMLElement).style.getPropertyValue('--tile-review-strip-height'))
      === Math.ceil(element.querySelector('.tile-review-strip')!.getBoundingClientRect().height),
  )).toBe(true)
}

// Click through the review input, using discovered DOM bounds in the frame.
// Calling the frame locator's click directly would bypass annotation interception.
async function reviewClick(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/redline-feedback-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml }))
  await page.route('**/document', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: reviewedDocument }))
  await page.route('**/sdk.js', route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: sdk }))
  await page.route('**/default.css', route => route.fulfill({ contentType: 'text/css; charset=utf-8', body: theme }))
  await page.goto('/redline-feedback-fixture')
  await expect(strip(page)).toContainText('1 queued')
  await expect(strip(page).getByRole('button', { name: /Answer queue · 3/ })).toBeVisible()
})

test('wide tray reserves readable page space; narrow sheet keeps summary/actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openQueue(page)
  await assertSummaryAndBounds(page)
  await expect.poll(async () => {
    const reading = await page.locator('iframe').boundingBox()
    const tray = await drawer(page).boundingBox()
    return Boolean(reading && tray && reading.width >= 700 && reading.x + reading.width <= tray.x && tray.width === 400)
  }).toBe(true)
  await expect(strip(page).getByRole('button', { name: /Answer queue/ })).toHaveAttribute('aria-expanded', 'true')

  await page.setViewportSize({ width: 420, height: 760 })
  await assertSummaryAndBounds(page)
  await expect.poll(async () => (await drawer(page).boundingBox())!.width).toBeGreaterThan(400)
  await expect.poll(async () => (await page.locator('iframe').boundingBox())!.width).toBe(420)
  await drawer(page).getByRole('button', { name: /Backend question\?/ }).click()
  await expect(documentFrame(page).locator('#architecture')).toBeVisible()
  await expect(documentFrame(page).locator('#overview')).toBeHidden()
  await expect(documentFrame(page).getByRole('tab', { name: 'Backend', exact: true })).toHaveAttribute('aria-selected', 'true')
  await drawer(page).getByRole('button', { name: 'Show in page', exact: true }).click()
  await expect(documentFrame(page).locator('#backend-question')).toBeFocused()
  await drawer(page).getByRole('button', { name: 'Collapse review queue' }).click()
  await expect(documentFrame(page).getByRole('combobox', { name: 'Section', exact: true })).toBeVisible()
})

test('annotation mode navigates SDK rail/picker controls and annotates ordinary product targets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Review this page', exact: true }).click()
  await reviewClick(page, documentFrame(page).locator('redline-nav a[href="#details"]'))
  await expect(documentFrame(page).locator('#details')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue note', exact: true })).toHaveCount(0)
  await reviewClick(page, documentFrame(page).locator('redline-nav a[href="#overview"]'))
  await reviewClick(page, documentFrame(page).locator('#product-control'))
  await expect(page.getByRole('textbox', { name: 'Note about #product-control', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.setViewportSize({ width: 420, height: 760 })
  await reviewClick(page, documentFrame(page).getByRole('combobox', { name: 'Section', exact: true }))
  await expect(documentFrame(page).locator('.redline-review-picker')).toBeVisible()
  await reviewClick(page, documentFrame(page).locator('.redline-review-picker button').filter({ hasText: 'Details' }))
  await expect(documentFrame(page).locator('#details')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue note', exact: true })).toHaveCount(0)
  await reviewClick(page, documentFrame(page).getByRole('button', { name: 'View full document', exact: true }))
  await expect(documentFrame(page).locator('#overview')).toBeVisible()
  await expect(documentFrame(page).locator('#details')).toBeVisible()
})

test('queue edits and attachments survive reload; selective send and build stay distinct', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openQueue(page)
  await drawer(page).getByRole('button', { name: /#ordinary-evidence/ }).click()
  await drawer(page).getByRole('textbox', { name: 'Comment', exact: true }).fill('Readable hierarchy, please')
  await drawer(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await drawer(page).getByLabel('Add image attachment').setInputFiles({
    name: 'evidence.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5VAAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(drawer(page).getByRole('button', { name: 'Preview evidence.png' })).toBeVisible()
  await expect.poll(async () => (await queuedSnapshot(page)).notes[0].attachments?.length).toBe(1)
  await drawer(page).getByRole('button', { name: /What should we name it\?/ }).click()
  await expect(documentFrame(page).locator('#details')).toBeVisible()
  await drawer(page).getByRole('textbox', { name: 'Answer', exact: true }).fill('Redline')
  await drawer(page).getByRole('button', { name: 'Queue answer', exact: true }).click()
  await expect.poll(async () => (await queuedSnapshot(page)).notes.length).toBe(2)

  await page.reload()
  await expect(strip(page)).toContainText('2 queued')
  await openQueue(page)
  await drawer(page).getByRole('button', { name: /#ordinary-evidence/ }).click()
  await expect(drawer(page).getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('Readable hierarchy, please')
  await drawer(page).getByRole('button', { name: 'Preview evidence.png' }).click()
  await expect(page.getByRole('dialog', { name: 'Preview evidence.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Close attachment preview' }).click()
  await drawer(page).getByRole('button', { name: 'Send this', exact: true }).click()
  await expect.poll(async () => (await queuedSnapshot(page)).notes.length).toBe(1)
  expect(await page.evaluate(() => (window as any).feedbackFixture.sentIntents)).toEqual(['send'])
  await drawer(page).getByRole('button', { name: /What should we name it\?/ }).click()
  await expect(drawer(page).getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue('Redline')
  await strip(page).getByRole('button', { name: 'Send all + Build', exact: true }).click()
  await expect.poll(async () => (await queuedSnapshot(page)).notes.length).toBe(0)
  expect(await page.evaluate(() => (window as any).feedbackFixture.sentIntents)).toEqual(['send', 'build'])
  await page.reload()
  await openQueue(page)
  await drawer(page).getByRole('button', { name: /What should we name it\?/ }).click()
  await expect(drawer(page).getByRole('button', { name: 'Change answer', exact: true })).toBeVisible()
  await expect(drawer(page).locator('.tile-review-sent')).toContainText('Redline')
})

test('short narrow tiles scroll the sheet without clipping editing, collapse, or primary send', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 280 })
  await openQueue(page)
  await assertSummaryAndBounds(page)
  await expect(page.locator('.web-pane-native-slot')).toHaveAttribute('data-review-short-tile', '')
  await drawer(page).getByRole('button', { name: /#ordinary-evidence/ }).click()
  await drawer(page).getByRole('textbox', { name: 'Comment', exact: true }).fill('Short viewport edit')
  await drawer(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await queuedSnapshot(page)).notes[0].comment).toBe('Short viewport edit')
  await drawer(page).getByRole('button', { name: 'Collapse review queue' }).click()
  await expect(drawer(page)).toHaveCount(0)
  await openQueue(page)
  await strip(page).getByRole('button', { name: 'Send all', exact: true }).click()
  await expect.poll(async () => (await queuedSnapshot(page)).notes.length).toBe(0)
  expect(await page.evaluate(() => (window as any).feedbackFixture.sentIntents)).toEqual(['send'])
})
