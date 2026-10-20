import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChromiumEngine } from './chromium-engine.js'
import { WebPaneError } from './web-panes.js'

function fakeEngine() {
  const browser = { launch: { port: 9222 }, cdp: { send: vi.fn(async (method: string, _params?: unknown) => method === 'Target.createBrowserContext' ? { browserContextId: 'isolated' } : { targetId: 'export' }), sendAndForget: vi.fn() } }
  let load: () => void = () => {}
  const page = { close: vi.fn(), on: vi.fn((_event: string, handler: (params: Record<string, unknown>) => void) => { load = () => handler({}) }),
    send: vi.fn(async (method: string, _params?: unknown) => { if (method === 'Page.navigate') load(); return method === 'Page.captureScreenshot' ? { data: Buffer.from('png').toString('base64') } : {} }) }
  const engine = new ChromiumEngine({ classify: () => ({ kind: 'open' }), onExternalNavigation: vi.fn() })
  // Inject browser plumbing and a page CDP fake; no sockets or browser process.
  const ensure = vi.spyOn(engine as unknown as { ensureBrowser: () => Promise<unknown> }, 'ensureBrowser').mockResolvedValue(browser)
  const connect = vi.fn(async () => page)
  return { engine, browser, page, ensure, connect }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('ChromiumEngine temporary screenshot', () => {
  it('captures at the requested viewport and 2x scale without tile state and closes its target', async () => {
    const { engine, browser, page, connect } = fakeEngine()
    expect(await engine.screenshot('http://localhost/frame.html', 390, 844, connect)).toEqual(Buffer.from('png'))
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/page/export', 15000)
    expect(page.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })
    expect(browser.cdp.send).toHaveBeenCalledWith('Target.createBrowserContext', { disposeOnDetach: true })
    expect(browser.cdp.send).toHaveBeenCalledWith('Target.createTarget', expect.objectContaining({ browserContextId: 'isolated' }))
    expect(page.send).toHaveBeenCalledWith('Page.navigate', { url: 'http://localhost/redline/capture.html' })
    const embed = (page.send.mock.calls.find(([method]) => method === 'Runtime.evaluate')![1] as { expression: string }).expression
    expect(embed).toContain(`frame.setAttribute('sandbox', 'allow-scripts')`)
    expect(embed).toContain('frame.width = 390; frame.height = 844;')
    expect(embed).toContain('frame.src = "http://localhost/frame.html"')
    expect(browser.cdp.sendAndForget).toHaveBeenCalledWith('Target.disposeBrowserContext', { browserContextId: 'isolated' })
    expect(page.send).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    expect(page.send.mock.calls.some(([method]) => /Binding|ScriptToEvaluate|Screencast/.test(method))).toBe(false)
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.cdp.sendAndForget).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'export' })
    expect(engine.hasTile('export')).toBe(false)
  })
  it('closes its target on navigation/capture failure and surfaces browser unavailability', async () => {
    const { engine, browser, page, ensure, connect } = fakeEngine()
    page.send.mockRejectedValueOnce(new Error('CDP failed'))
    await expect(engine.screenshot('http://localhost/frame.html', 390, 844, connect)).rejects.toThrow('CDP failed')
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.cdp.sendAndForget).toHaveBeenCalledTimes(2)
    ensure.mockRejectedValueOnce(new WebPaneError(503, 'No Chromium-family browser found'))
    await expect(engine.screenshot('http://localhost/frame.html', 390, 844, connect)).rejects.toMatchObject({ status: 503 })
  })
  it('times out after 15s and closes a target that arrives after the deadline', async () => {
    vi.useFakeTimers()
    const { engine, browser, connect } = fakeEngine()
    let finish!: (value: { targetId: string }) => void
    browser.cdp.send.mockImplementationOnce(async () => ({ browserContextId: 'isolated' })).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const result = engine.screenshot('http://localhost/frame.html', 390, 844, connect)
    const rejected = expect(result).rejects.toMatchObject({ status: 504, message: 'PNG export timed out after 15s' })
    await vi.advanceTimersByTimeAsync(15000); await rejected
    finish({ targetId: 'late' }); await vi.advanceTimersByTimeAsync(0)
    expect(browser.cdp.sendAndForget).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'late' }); expect(connect).not.toHaveBeenCalled()
  })
  it('cleans up an already connected target when the page never finishes loading', async () => {
    vi.useFakeTimers()
    const { engine, browser, page, connect } = fakeEngine()
    page.on.mockImplementation(() => {})
    const result = engine.screenshot('http://localhost/frame.html', 390, 844, connect)
    const rejected = expect(result).rejects.toMatchObject({ status: 504 })
    await vi.advanceTimersByTimeAsync(15000); await rejected
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.cdp.sendAndForget).toHaveBeenCalledTimes(2)
  })
  it.each([0, -1, Infinity, NaN, 8193])('rejects unsafe dimensions %s before opening a browser', async (size) => {
    const { engine, ensure, connect } = fakeEngine()
    await expect(engine.screenshot('http://localhost/frame.html', size, 844, connect)).rejects.toMatchObject({ status: 400 })
    expect(ensure).not.toHaveBeenCalled()
  })
})
