import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { selectorRevealExpression } from '../shared/tile-inspect'

const sdk = readFileSync(new URL('../server/static/redline-sdk.js', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../server/static/redline-default.css', import.meta.url), 'utf8')
const documentHtml = readFileSync(new URL('./fixtures/redline-sections.html', import.meta.url), 'utf8')

async function selectSection(page: Page, id: string) {
  if ((page.viewportSize()?.width || 0) <= 620) await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption(id)
  else await page.locator(`redline-nav a[href="#${id}"]`).click()
  await expect(page.locator(`#${id}`)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('https://redline.test/**', route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', body: path === '/sdk.js' ? sdk : path === '/default.css' ? theme : documentHtml })
  })
})

for (const width of [420, 768, 1440]) {
  test(`focused routes, Back, reading positions and full-document mode at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 760 })
    await page.goto('https://redline.test/document')
    await expect(page.locator('#overview')).toBeVisible()
    await expect(page.locator('#details')).toBeHidden()
    await expect(page.locator('redline-nav a')).toHaveCount(4) // nested marker isn't another page
    if (width <= 620) {
      await expect(page.getByRole('combobox', { name: 'Section', exact: true })).toBeVisible()
      await expect(page.locator('.redline-nav-links')).toBeHidden()
    } else {
      await expect(page.locator('.redline-nav-links')).toBeVisible()
      await expect(page.locator('.redline-section-picker')).toBeHidden()
    }
    await page.locator('#direction textarea').fill('Keep this unsaved note')
    await page.evaluate(() => { (window as any).originalControl = document.querySelector('#direction'); window.scrollTo(0, 320) })
    const readingPosition = await page.evaluate(() => scrollY)
    await selectSection(page, 'details')
    await expect(page).toHaveURL(/#details$/)
    await expect(page.locator('#details h2')).toBeFocused()
    await page.goBack()
    await expect(page.locator('#overview')).toBeVisible()
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(readingPosition)
    expect(await page.evaluate(() => (window as any).originalControl === document.querySelector('#direction'))).toBe(true)
    await expect(page.locator('#direction textarea')).toHaveValue('Keep this unsaved note')
    await page.getByRole('button', { name: 'View full document', exact: true }).click()
    await expect(page.locator('#overview')).toBeVisible()
    await expect(page.locator('#details')).toBeVisible()
    await expect(page.locator('#architecture')).toBeHidden() // full mode scans the active discussion
    await expect(page.locator('.redline-section-pager')).toBeHidden()
    await page.getByRole('button', { name: 'Return to focused sections', exact: true }).click()
    await expect(page.locator('#details')).toBeHidden()
    await page.getByRole('button', { name: 'Next section →', exact: true }).click()
    await expect(page.locator('#details')).toBeVisible()
    await page.getByRole('button', { name: '← Previous', exact: true }).click()
    await expect(page.locator('#overview')).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('#details')).toBeVisible()
    await expect(page.locator('#architecture')).toBeVisible()
    await expect(page.locator('redline-nav')).toBeHidden()
    await page.emulateMedia({ media: 'screen' })
    await expect(page.locator('#details')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}

test('nested deep links refresh and Back reveal the right track before scrolling', async ({ page }) => {
  await page.goto('https://redline.test/document#nested-evidence')
  await expect(page.locator('#details')).toBeVisible()
  await expect(page.locator('#overview')).toBeHidden()
  await expect(page.locator('a[href="#details"]')).toHaveAttribute('aria-current', 'page')
  await expect(page).toHaveURL('https://redline.test/document#nested-evidence')
  await page.reload()
  await expect(page).toHaveURL('https://redline.test/document#nested-evidence')
  await expect(page.locator('#nested-evidence')).toBeInViewport()
  expect(await page.evaluate(selectorRevealExpression('#hidden-target'))).toBe(true)
  await expect(page.locator('#architecture')).toBeVisible()
  await expect(page.locator('#hidden-target')).toBeVisible()
  await expect(page.locator('#hidden-target')).toBeFocused()
  await expect(page.locator('#hidden-target')).toBeInViewport()
  await expect(page.getByRole('tab', { name: 'Backend' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('redline-nav a[href="#overview"]')).toBeHidden()
  await expect(page.locator('redline-nav a[href="#log"]')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('https://redline.test/document#nested-evidence')
  await expect(page.locator('#details')).toBeVisible()
  await expect(page.locator('#nested-evidence')).toBeInViewport()
  await page.getByRole('tab', { name: 'Backend' }).click()
  await expect(page).toHaveURL(/#architecture$/)
  await page.locator('redline-nav a[href="#log"]').click()
  await expect(page.locator('#log')).toBeVisible()
})

test('hidden questions stay in inventory and queued/sent identities recover across section hashes and reload', async ({ page }) => {
  await page.goto('https://redline.test/document')
  await expect.poll(() => page.evaluate(() => (window as any).inventory?.map((q: any) => q.queueKey).sort())).toEqual(['backend', 'direction', 'name'])
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('1 unanswered')
  await page.locator('#direction label').filter({ hasText: 'Slate' }).click()
  await expect(page.locator('#direction').getByRole('radio', { name: 'Slate', exact: true })).toBeChecked()
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('1 queued')
  await selectSection(page, 'details')
  await page.reload()
  await selectSection(page, 'overview')
  await expect(page.locator('#direction').getByRole('radio', { name: 'Slate', exact: true })).toBeChecked()
  await page.locator('#direction textarea').fill('Changed after queuing')
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('changed since review')
  await page.locator('#direction').getByRole('button', { name: 'Update queued answer' }).click()
  expect(await page.evaluate(() => (window as any).reviews.controls.length)).toBe(1)
  await page.evaluate(() => {
    const win = window as any
    const control = win.reviews.controls[0]
    win.reviews.sent = [{ queueKey: control.queueKey, selector: control.selector, shape: win.inventory.find((q: any) => q.queueKey === control.queueKey), response: control.response, sentAt: Date.now() }]
    win.reviews.controls = []
    win.publishReview()
  })
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('1 sent/settled')
  await page.reload()
  await expect(page.locator('#direction')).toHaveAttribute('data-redline-sent', '1')
  await expect(page.locator('redline-nav a[href="#overview"]')).not.toContainText('unanswered')
  await page.evaluate(() => {
    const win = window as any
    win.reviews.sent[0].shape.question = 'A superseded prompt'
    win.publishReview()
  })
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('1 unanswered')
  await expect(page.locator('redline-nav a[href="#overview"]')).toContainText('changed since review')
})

test('explicit scroll and mode-less documents retain continuous navigation', async ({ page }) => {
  for (const mode of ['scroll', '']) {
    await page.route('https://redline.test/legacy', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: documentHtml.replace('mode="sections"', mode ? `mode="${mode}"` : '') }))
    await page.goto('https://redline.test/legacy')
    await expect(page.locator('#overview')).toBeVisible()
    await expect(page.locator('#details')).toBeVisible()
    await expect(page.locator('.redline-view-toggle')).toHaveCount(0)
    await page.locator('redline-nav a[href="#details"]').click()
    await expect(page.locator('#details h2')).toBeInViewport()
    await page.unroute('https://redline.test/legacy')
  }
})
