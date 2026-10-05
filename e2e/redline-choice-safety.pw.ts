import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const sdk = readFileSync(new URL('../server/static/redline-sdk.js', import.meta.url), 'utf8')

for (const width of [420, 1440]) {
  test(`choice prose survives parser-time SDK loading at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('https://redline.test/**', async (route) => {
      if (route.request().url().endsWith('/sdk.js')) {
        await route.fulfill({ contentType: 'text/javascript', body: sdk })
        return
      }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><script>
          window.calls = [];
          window.__commandoRedlineQueue = payload => window.calls.push(JSON.parse(payload));
        </script><script src="/sdk.js"></script></head><body>
          <redline-choice key="attachments" prompt="Attachments?">
            <redline-option>Carry attachments, including "inline" images</redline-option>
            <redline-option>Say attachments aren't supported &amp; forward text</redline-option>
          </redline-choice>
          <redline-choice key="broken" prompt="Broken?"
            options='["Carry attachments","Attachments aren't supported"]'></redline-choice>
          <redline-choice key="resolved" prompt="Settled?" resolved answer="Carry attachments, including &quot;inline&quot; images">
            <redline-option>Carry attachments, including "inline" images</redline-option>
            <redline-option>Forward text</redline-option>
          </redline-choice>
        </body></html>` })
    })
    await page.goto('https://redline.test/')
    const choice = page.locator('redline-choice[key="attachments"]')
    await expect(choice.getByRole('radio')).toHaveCount(2)
    await expect(choice.locator('redline-option').first()).toBeHidden()
    await choice.locator('label').filter({ hasText: "Say attachments aren't supported & forward text" }).click()
    await expect(choice.getByRole('radio', { name: "Say attachments aren't supported & forward text", exact: true })).toBeChecked()
    expect(await page.evaluate(() => (window as any).calls.find((call: any) => call.queueKey === 'attachments')?.answer))
      .toBe("Say attachments aren't supported & forward text")
    await expect(page.locator('redline-choice[key="broken"]').getByRole('alert')).toContainText('Invalid choice options')
    await expect(page.locator('redline-choice[key="broken"]').getByRole('radio')).toHaveCount(0)
    const resolved = page.locator('redline-choice[key="resolved"]')
    await resolved.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(resolved.getByRole('radio', { name: 'Carry attachments, including "inline" images', exact: true })).toBeChecked()
  })
}
