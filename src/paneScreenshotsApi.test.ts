import { describe, expect, it, vi } from 'vitest'

import { createPaneScreenshotsApi, paneScreenshotUrl, PaneScreenshotsApiError } from './paneScreenshotsApi'

describe('pane screenshots API', () => {
  it('cache-busts image URLs with the file modification time', () => {
    expect(paneScreenshotUrl('0123456789abcdef', 'round one.png', 123.5))
      .toBe('/screenshots/0123456789abcdef/round%20one.png?v=123.5')
  })

  it('maps a 404 listing response to a typed not_found error', async () => {
    const api = createPaneScreenshotsApi('token', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    ))

    await expect(api.list('0123456789abcdef')).rejects.toEqual(
      expect.objectContaining<Partial<PaneScreenshotsApiError>>({ code: 'not_found', message: 'Not found' }),
    )
  })
})
