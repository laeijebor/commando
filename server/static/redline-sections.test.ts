// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const sdk = readFileSync(join(__dirname, 'redline-sdk.js'), 'utf8')
const win = window as any
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const snapshot = (controls: unknown[] = [], sent: unknown[] = []) => {
  win.__commandoRedlinePendingSnapshot = { version: 1, controls, sent }
  window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: win.__commandoRedlinePendingSnapshot }))
}
const fixture = `<div class="redline-layout"><redline-nav mode="sections" heading="Review" summary="Choose a direction"></redline-nav><main>
  <redline-tracks default="one"></redline-tracks>
  <section id="first" data-redline-section data-redline-label="First" data-redline-group="Plan" data-redline-track="one"><h2>First heading</h2><redline-ask id="ask" key="ask" prompt="Name?" required></redline-ask></section>
  <section id="second" data-redline-section data-redline-label="Second" data-redline-group="Plan" data-redline-track="one"><h2>Second heading</h2><section id="nested" data-redline-section><p id="target">Nested evidence</p><redline-choice id="choice" key="choice" prompt="Plan?" options="A,B"></redline-choice></section></section>
  <section id="other" data-redline-section data-redline-label="Other" data-redline-group="Details" data-redline-track="two"><h2>Other heading</h2><redline-ask id="hidden-ask" key="hidden" prompt="Hidden question?"></redline-ask></section>
  <section id="log" data-redline-section data-redline-label="Log" data-redline-track="one" data-redline-track-all><h2>Log</h2><redline-approve key="done" prompt="Done?" resolved answer="approve" locked></redline-approve></section>
</main></div>`
beforeAll(() => {
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  win.__commandoRedlineQueue = vi.fn()
  window.eval(sdk)
})
beforeEach(() => {
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  Element.prototype.scrollIntoView = vi.fn()
  snapshot()
})
afterEach(async () => { document.body.innerHTML = ''; await flush(); vi.restoreAllMocks() })
const mount = async () => { document.body.innerHTML = fixture; await flush() }
const nav = () => document.querySelector('redline-nav') as any
const link = (id: string) => document.querySelector(`redline-nav a[href="#${id}"]`) as HTMLAnchorElement
const sectionHidden = (id: string) => document.getElementById(id)!.hasAttribute('data-redline-section-hidden')

describe('focused Redline sections', () => {
  it('preserves the initial nested hash when navigation starts before tracks activate', async () => {
    // Reproduce parser-time startup ordering: normal nav initialization runs
    // while the track component's initial render is still deferred.
    const Tracks = customElements.get('redline-tracks')!
    vi.spyOn(Tracks.prototype, 'render').mockImplementationOnce(() => undefined)
    history.replaceState(null, '', '#target')
    document.body.innerHTML = fixture
    const tracks = document.querySelector('redline-tracks') as any
    expect(tracks._active).toBeUndefined()
    await flush()
    expect(location.hash).toBe('#target')
    expect(sectionHidden('second')).toBe(false)
    expect(link('second').getAttribute('aria-current')).toBe('page')
    tracks.render()
    expect(location.hash).toBe('#target')
    expect(sectionHidden('second')).toBe(false)
  })

  it('keeps controls mounted, groups logical roots, and restores each reading position', async () => {
    await mount()
    const input = document.querySelector('#ask textarea') as HTMLTextAreaElement
    input.value = 'Unsaved draft'
    expect(sectionHidden('first')).toBe(false)
    expect(sectionHidden('second')).toBe(true)
    expect(document.querySelectorAll('redline-nav a')).toHaveLength(4)
    expect(link('other').hidden).toBe(true)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(240)
    link('second').click()
    expect(location.hash).toBe('#second')
    expect(sectionHidden('first')).toBe(true)
    expect(document.activeElement?.textContent).toBe('Second heading')
    link('first').click()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 240, behavior: 'instant' })
    expect(document.querySelector('#ask textarea')).toBe(input)
    expect(input.value).toBe('Unsaved draft')
    expect(link('first').getAttribute('aria-current')).toBe('page')
    expect(link('first').textContent).toContain('1 unanswered')
  })

  it('routes refresh, nested hashes, Back, and reveal across tracks', async () => {
    history.replaceState(null, '', '#target')
    await mount()
    expect(sectionHidden('second')).toBe(false)
    expect(link('second').getAttribute('aria-current')).toBe('page')
    const replace = vi.spyOn(history, 'replaceState')
    const priorHashes: string[] = []
    const pushState = history.pushState.bind(history)
    const push = vi.spyOn(history, 'pushState').mockImplementation((data, unused, url) => {
      priorHashes.push(location.hash)
      pushState(data, unused, url)
    })
    win.redline.revealSelector('#hidden-ask')
    expect(replace).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledExactlyOnceWith(null, '', '#hidden-ask')
    expect(priorHashes).toEqual(['#target'])
    expect(location.hash).toBe('#hidden-ask')
    expect(document.getElementById('other')!.hasAttribute('data-redline-track-hidden')).toBe(false)
    expect(sectionHidden('other')).toBe(false)
    expect(link('first').hidden).toBe(true)
    expect(link('log').hidden).toBe(false)
    history.replaceState(null, '', '#target')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(sectionHidden('second')).toBe(false)
    expect(link('other').hidden).toBe(true)
    expect(win.redline.revealSelector('[bad')).toBe(false)
    expect(win.redline.revealSelector('#missing')).toBe(false)
  })

  it('supports the labelled picker, previous/next, full document, and DOM bridge', async () => {
    await mount()
    const picker = document.querySelector('.redline-section-picker select') as HTMLSelectElement
    picker.value = 'second'
    picker.dispatchEvent(new Event('change'))
    expect(sectionHidden('second')).toBe(false)
    document.querySelector<HTMLButtonElement>('.redline-section-pager button')!.click()
    expect(sectionHidden('first')).toBe(false)
    const toggle = document.querySelector<HTMLButtonElement>('.redline-view-toggle')!
    toggle.click()
    expect(sectionHidden('second')).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    expect(sectionHidden('second')).toBe(true)
    picker.dispatchEvent(new Event('redline-navigation-click', { bubbles: true }))
    expect(picker.hasAttribute('data-redline-navigation-result')).toBe(true)
    expect(document.querySelector<HTMLElement>('.redline-review-picker')!.hidden).toBe(false)
    document.querySelectorAll<HTMLButtonElement>('.redline-review-picker button')[1].click()
    expect(sectionHidden('second')).toBe(false)
    const target = document.getElementById('hidden-ask')!
    target.dispatchEvent(new Event('redline-reveal-target', { bubbles: true }))
    expect(target.hasAttribute('data-redline-reveal-result')).toBe(true)
    expect(sectionHidden('other')).toBe(false)
  })

  it('inventories hidden/nested questions once, recovers pending values, and derives truthful status', async () => {
    await mount()
    const questions = win.__commandoRedlineQuestionSnapshot.questions
    expect(questions.map((q: any) => q.queueKey).sort()).toEqual(['ask', 'choice', 'hidden'])
    snapshot([{ queueKey: 'ask', response: { question: 'Name?', answer: 'Recovered' } }])
    expect((document.querySelector('#ask textarea') as HTMLTextAreaElement).value).toBe('Recovered')
    expect(link('first').textContent).toContain('1 queued')
    const input = document.querySelector('#ask textarea') as HTMLTextAreaElement
    input.value = 'Changed locally'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(link('first').textContent).toContain('1 changed since review')
    const shape = questions.find((q: any) => q.queueKey === 'choice')
    snapshot([], [{ queueKey: 'choice', selector: '#choice', shape, response: { question: 'Plan?', answer: 'B' }, sentAt: Date.now() }])
    expect(link('second').textContent).toContain('1 sent/settled')
    expect(link('second').textContent).not.toContain('unanswered')
    expect(link('log').textContent).toContain('1 sent/settled')
    snapshot([], [{ queueKey: 'choice', shape: { ...shape, question: 'Old plan?' }, response: { question: 'Old plan?', answer: 'B' }, sentAt: Date.now() }])
    expect(link('second').textContent).toContain('1 unanswered')
    expect(link('second').textContent).toContain('1 changed since review')
    document.getElementById('other')!.append(document.querySelector('#ask')!.cloneNode(true))
    await flush()
    expect(win.__commandoRedlineQuestionSnapshot.questions.filter((q: any) => q.queueKey === 'ask')).toHaveLength(1)
    expect(link('other').textContent).toContain('1 unanswered')
  })

  it('bridges desktop isolated-world inspection/reveal without relying on page JavaScript globals', async () => {
    await mount()
    const bridge = readFileSync(join(__dirname, '../../apps/desktop/Sources/CommandoDesktop/WebViewTileBridge.swift'), 'utf8')
    const extract = (name: string) => bridge.split(`static let ${name} = """`)[1].split('"""')[0]
    const isolatedWindow = { matchMedia: () => ({ matches: true }) }
    const target = link('second').firstChild as HTMLElement
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
    const inspect = new Function('window', 'inspectGrade', 'inspectX', 'inspectY', extract('inspectAtPointScript'))
    expect(inspect(isolatedWindow, 'hover', 1, 1)).toMatchObject({ navigation: true })
    expect(sectionHidden('first')).toBe(false)
    expect(inspect(isolatedWindow, 'click', 1, 1)).toMatchObject({ navigation: true })
    expect(sectionHidden('second')).toBe(false)
    expect(target.hasAttribute('data-redline-navigation-result')).toBe(false)
    const reveal = new Function('window', 'revealSelector', extract('revealSelectorScript'))
    expect(reveal(isolatedWindow, '#hidden-ask')).toBe(true)
    expect(sectionHidden('other')).toBe(false)
    expect(document.getElementById('other')!.hasAttribute('data-redline-track-hidden')).toBe(false)
    expect(document.getElementById('hidden-ask')!.hasAttribute('data-redline-reveal-result')).toBe(false)
    expect(reveal(isolatedWindow, '[bad')).toBe(false)
  })

  it('removes route listeners and visibility on disconnect, then reconnects cleanly', async () => {
    await mount()
    const navigator = nav()
    navigator.remove()
    expect(sectionHidden('second')).toBe(false)
    expect(document.querySelector('.redline-section-pager')).toBeNull()
    history.replaceState(null, '', '#second')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(sectionHidden('first')).toBe(false)
    document.querySelector('.redline-layout')!.prepend(navigator)
    await flush()
    expect(sectionHidden('second')).toBe(false)
    expect(document.querySelectorAll('.redline-section-pager')).toHaveLength(1)
  })
})
