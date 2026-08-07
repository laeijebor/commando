// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(join(__dirname, 'redline-sdk.js'), 'utf8')

// jsdom (27.x) does not implement CSS.escape at all — real browsers do, and the
// SDK is written against the real browser API. Polyfill it once for the whole
// file so the SDK's own escaping logic runs unmodified under test.
// Adapted from the W3C CSSOM spec / Mathias Bynens' CSS.escape polyfill (MIT).
if (typeof (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape !== 'function') {
  ;(globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
    escape(value: string): string {
      const string = String(value)
      const length = string.length
      let index = -1
      let result = ''
      const firstCodeUnit = string.charCodeAt(0)
      while (++index < length) {
        const codeUnit = string.charCodeAt(index)
        if (codeUnit === 0x0000) {
          result += '�'
          continue
        }
        if (
          (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
          codeUnit === 0x007f ||
          (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
        ) {
          result += `\\${codeUnit.toString(16)} `
          continue
        }
        if (index === 0 && length === 1 && codeUnit === 0x002d) {
          result += `\\${string.charAt(index)}`
          continue
        }
        if (
          codeUnit >= 0x0080 ||
          codeUnit === 0x002d ||
          codeUnit === 0x005f ||
          (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
          (codeUnit >= 0x0061 && codeUnit <= 0x007a)
        ) {
          result += string.charAt(index)
          continue
        }
        result += `\\${string.charAt(index)}`
      }
      return result
    },
  }
}

type QueueCall = { question: string; answer: string; data?: unknown; queueKey?: string; selector?: string; tag?: string; rect?: unknown }

function loadSdk(): QueueCall[] {
  const calls: QueueCall[] = []
  ;(window as unknown as Record<string, unknown>).__commandoRedlineQueue = (payload: string) => {
    calls.push(JSON.parse(payload) as QueueCall)
  }
  // eslint-disable-next-line no-eval -- executing the served asset under test
  window.eval(source)
  return calls
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-redline-styles]').forEach((s) => s.remove())
  delete (window as unknown as Record<string, unknown>).__commandoRedlineQueue
  delete (window as unknown as Record<string, unknown>).redline
})

afterEach(() => {
  vi.useRealTimers()
})

describe('window.redline.queueResponse', () => {
  it('serializes the payload through the binding', () => {
    const calls = loadSdk()
    const target = document.createElement('div')
    target.id = 'target'
    document.body.append(target)
    const ok = (window as any).redline.queueResponse({
      question: 'Which plan?',
      answer: 'Pro',
      data: { choice: 'Pro' },
      queueKey: 'plan',
      element: target,
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].question).toBe('Which plan?')
    expect(calls[0].answer).toBe('Pro')
    expect(calls[0].queueKey).toBe('plan')
    expect(calls[0].selector).toBe('#target')
    expect(calls[0].tag).toBe('div')
    expect(calls[0].rect).toBeDefined()
  })

  it('returns false without the binding', () => {
    window.eval(source)
    expect((window as any).redline.queueResponse({ question: 'q', answer: 'a' })).toBe(false)
  })

  it('drops oversized data but still queues the answer, badge shown honestly', () => {
    const calls = loadSdk()
    const target = document.createElement('div')
    target.id = 'target'
    document.body.append(target)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = (window as any).redline.queueResponse({
      question: 'Which plan?',
      answer: 'Pro',
      data: { blob: 'x'.repeat(5000) },
      element: target,
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].question).toBe('Which plan?')
    expect(calls[0].answer).toBe('Pro')
    expect(calls[0].data).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('drops unserializable data but still queues the answer', () => {
    const calls = loadSdk()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const ok = (window as any).redline.queueResponse({ question: 'q', answer: 'a', data: circular })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].data).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('redline-choice', () => {
  it('renders options and queues only on the explicit button', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const radios = host.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    const button = host.querySelector('button') as HTMLButtonElement
    ;(radios[1] as HTMLInputElement).click()
    expect(calls).toHaveLength(0) // selection alone must not queue
    button.click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'Which plan?', answer: 'Pro', queueKey: 'plan' })
    expect(host.textContent).toContain('queued')
  })

  it('does nothing when no option is selected', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="plan" prompt="Which plan?" options="A,B"></redline-choice>'
    ;(document.querySelector('redline-choice button') as HTMLButtonElement).click()
    expect(calls).toHaveLength(0)
  })

  it('supports multiple selection', () => {
    const calls = loadSdk()
    document.body.innerHTML =
      '<redline-choice key="feat" prompt="Keep which?" options="A,B,C" multiple></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const boxes = host.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    ;(boxes[0] as HTMLInputElement).click()
    ;(boxes[2] as HTMLInputElement).click()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0].answer).toBe('A, C')
  })
})

describe('redline-approve', () => {
  it('queues verdict with optional comment', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-approve key="hero" prompt="Hero section ok?"></redline-approve>'
    const host = document.querySelector('redline-approve') as HTMLElement
    const reject = [...host.querySelectorAll('input[type="radio"]')].find(
      (input) => (input as HTMLInputElement).value === 'reject',
    ) as HTMLInputElement
    reject.click()
    const comment = host.querySelector('textarea') as HTMLTextAreaElement
    comment.value = 'too loud'
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'Hero section ok?', answer: 'reject — too loud', queueKey: 'hero' })
    expect(calls[0].data).toMatchObject({ verdict: 'reject', comment: 'too loud' })
  })
})

describe('redline-rating', () => {
  it('queues the selected numeric rating', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-rating key="vibe" prompt="Rate the vibe" max="3"></redline-rating>'
    const host = document.querySelector('redline-rating') as HTMLElement
    const radios = host.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(3)
    ;(radios[2] as HTMLInputElement).click()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'Rate the vibe', answer: '3/3', queueKey: 'vibe' })
  })
})

describe('redline-ask', () => {
  it('queues free text', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-ask key="name" prompt="What should we call it?"></redline-ask>'
    const host = document.querySelector('redline-ask') as HTMLElement
    ;(host.querySelector('textarea') as HTMLTextAreaElement).value = 'Redline'
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'What should we call it?', answer: 'Redline', queueKey: 'name' })
  })
})

describe('redline-question', () => {
  it('collects values from wrapped native inputs', () => {
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-question key="opts" prompt="Configure it">
        <label>Port <input name="port" value="4310"></label>
        <label><input type="checkbox" name="tls" checked> TLS</label>
      </redline-question>`
    const host = document.querySelector('redline-question') as HTMLElement
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0].question).toBe('Configure it')
    expect(calls[0].answer).toContain('port: 4310')
    expect(calls[0].answer).toContain('tls: yes')
    expect(calls[0].data).toMatchObject({ port: '4310', tls: true })
  })
})

describe('binding-absent fallback', () => {
  it('disables queue buttons with a hint, and the poll gives up if the binding never appears', () => {
    vi.useFakeTimers()
    window.eval(source) // no binding installed
    document.body.innerHTML = '<redline-choice key="k" prompt="p" options="A,B"></redline-choice>'
    const button = document.querySelector('redline-choice button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title.toLowerCase()).toContain('commando')

    // Fast-forward well past the poll's give-up horizon — a plain-browser
    // page (no binding ever) must not leave a forever-running interval, and
    // the button must stay disabled with its hint.
    vi.advanceTimersByTime(20_000)
    expect(button.disabled).toBe(true)
    expect(button.title.toLowerCase()).toContain('commando')
  })
})

describe('injected styles', () => {
  it('injects the aura stylesheet exactly once across double evaluation', () => {
    loadSdk()
    window.eval(source) // second evaluation, defineOnce path
    const styles = document.head.querySelectorAll('style[data-redline-styles]')
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toContain(':where(redline-choice')
    expect(styles[0].textContent).toContain('--redline-accent')
  })

  it('ships no daisyui utility classes in rendered markup', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-choice key="k" prompt="p" options="A,B"></redline-choice>
      <redline-approve key="a" prompt="p"></redline-approve>
      <redline-rating key="r" prompt="p" max="3"></redline-rating>
      <redline-ask key="q" prompt="p"></redline-ask>`
    const html = document.body.innerHTML
    for (const cls of ['btn', 'radio', 'checkbox', 'textarea textarea-sm', 'badge', 'mask-star-2', 'rating']) {
      expect(html).not.toMatch(new RegExp(`class="[^"]*\\b${cls}\\b`))
    }
  })
})

describe('binding arrives after first paint', () => {
  it('re-arms a disabled queue button once the CDP binding shows up', () => {
    vi.useFakeTimers()
    window.eval(source) // binding absent at first paint, like a fresh tile target
    document.body.innerHTML =
      '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const button = host.querySelector('button.redline-queue') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title.toLowerCase()).toContain('commando')

    // Moments later, Runtime.addBinding finishes and the binding appears.
    const calls: QueueCall[] = []
    ;(window as unknown as Record<string, unknown>).__commandoRedlineQueue = (payload: string) => {
      calls.push(JSON.parse(payload) as QueueCall)
    }
    vi.advanceTimersByTime(250)

    expect(button.disabled).toBe(false)
    expect(button.title).toBe('')

    const radios = host.querySelectorAll('input[type="radio"]')
    ;(radios[1] as HTMLInputElement).click()
    button.click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'Which plan?', answer: 'Pro', queueKey: 'plan' })
  })
})
