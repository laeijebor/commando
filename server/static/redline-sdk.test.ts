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

type QueueCall = { question: string; answer: string; note?: string; data?: unknown; queueKey?: string; selector?: string; tag?: string; rect?: unknown }

type PendingSnapshot = {
  version: 1
  controls: Array<{
    queueKey?: string
    selector?: string
    response: { question: string; answer: string; note?: string; data?: unknown }
  }>
}

function publishSnapshot(snapshot: PendingSnapshot): void {
  ;(window as any).__commandoRedlinePendingSnapshot = snapshot
  window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: snapshot }))
}

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
  delete (window as unknown as Record<string, unknown>).__commandoRedlinePendingSnapshot
  delete (window as unknown as Record<string, unknown>).redline
  window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: { version: 1, controls: [] } }))
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
      note: 'Prioritize accessibility.',
      data: { choice: 'Pro' },
      queueKey: 'plan',
      element: target,
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].question).toBe('Which plan?')
    expect(calls[0].answer).toBe('Pro')
    expect(calls[0].note).toBe('Prioritize accessibility.')
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

  it('caps an optional note without changing the answer', () => {
    const calls = loadSdk()
    ;(window as any).redline.queueResponse({ question: 'q', answer: 'a', note: 'n'.repeat(1200) })
    expect(calls[0]).toMatchObject({ question: 'q', answer: 'a' })
    expect(calls[0].note).toHaveLength(1024)
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
    expect(host.querySelector('.redline-options')?.classList).toContain('redline-options-single')
    const button = host.querySelector('button') as HTMLButtonElement
    ;(radios[1] as HTMLInputElement).click()
    expect(calls).toHaveLength(0) // selection alone must not queue
    button.click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'Which plan?', answer: 'Pro', queueKey: 'plan' })
    expect(calls[0].data).toEqual({ choice: 'Pro', options: ['Starter', 'Pro'], multiple: false })
    expect(button.textContent).toBe('Queue answer') // the daemon snapshot is authoritative
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
    expect(host.querySelector('.redline-options')?.classList).toContain('redline-options-multiple')
    ;(boxes[0] as HTMLInputElement).click()
    ;(boxes[2] as HTMLInputElement).click()
    ;(host.querySelector('button') as HTMLButtonElement).click()
    expect(calls[0].answer).toBe('A, C')
  })
})

describe('redline-approve', () => {
  it('queues verdict and optional note separately', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-approve key="hero" prompt="Hero section ok?"></redline-approve>'
    const host = document.querySelector('redline-approve') as HTMLElement
    const reject = [...host.querySelectorAll('input[type="radio"]')].find(
      (input) => (input as HTMLInputElement).value === 'reject',
    ) as HTMLInputElement
    reject.click()
    const note = host.querySelector('textarea') as HTMLTextAreaElement
    note.value = 'too loud'
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ question: 'Hero section ok?', answer: 'reject', note: 'too loud', queueKey: 'hero' })
    expect(calls[0].data).toEqual({ verdict: 'reject' })
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
    expect(host.querySelectorAll('textarea[data-redline-note]')).toHaveLength(1)
    expect((calls[0].data as Record<string, unknown>).note).toBeUndefined()
  })

  it('renders in document order: prompt first, author children in the middle, button last', () => {
    // Pins the contract that connectedCallback's DOMContentLoaded deferral
    // (for the <head>-script case where children parse after the opening
    // tag) is meant to produce. The innerHTML path here has the full subtree
    // already parsed before connectedCallback runs, so this passes today —
    // it documents the ordering the deferral preserves for the streaming case.
    loadSdk()
    document.body.innerHTML = `
      <redline-question key="opts" prompt="Configure it">
        <label>Port <input name="port" value="4310"></label>
      </redline-question>`
    const host = document.querySelector('redline-question') as HTMLElement
    const children = [...host.children]
    expect(children[0].className).toBe('redline-prompt')
    expect(children[children.length - 1].tagName).toBe('BUTTON')
    expect(children.slice(1, -1).some((el) => el.tagName === 'LABEL')).toBe(true)
  })

  it('keeps the SDK note separate from authored field data', () => {
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-question key="opts" prompt="Configure it">
        <textarea name="details">Keep this authored value</textarea>
      </redline-question>`
    const host = document.querySelector('redline-question') as HTMLElement
    ;(host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement).value = 'Reviewer-only note'
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls[0]).toMatchObject({ note: 'Reviewer-only note', data: { details: 'Keep this authored value' } })
  })
})

describe('daemon pending snapshot state', () => {
  it('hydrates a cached keyed answer and tracks dirty/revert state', () => {
    const snapshot: PendingSnapshot = {
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Pro', note: 'Keep it focused.', data: { choice: 'Pro' } },
      }],
    }
    ;(window as any).__commandoRedlinePendingSnapshot = snapshot
    loadSdk()
    document.body.innerHTML = '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const radios = host.querySelectorAll('input[type="radio"]')
    const note = host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement
    const button = host.querySelector('button.redline-queue') as HTMLButtonElement

    expect((radios[1] as HTMLInputElement).checked).toBe(true)
    expect(note.value).toBe('Keep it focused.')
    expect(button.textContent).toBe('Queued ✓')
    expect(button.dataset.queued).toBe('1')

    ;(radios[0] as HTMLInputElement).click()
    expect(button.textContent).toBe('Update queued answer')
    expect(host.querySelector('.redline-queued-badge')?.textContent).toBe('Changed since queued')
    ;(radios[1] as HTMLInputElement).click()
    expect(button.textContent).toBe('Queued ✓')

    note.value = 'Changed note'
    note.dispatchEvent(new Event('input', { bubbles: true }))
    expect(button.textContent).toBe('Update queued answer')
    note.value = 'Keep it focused.'
    note.dispatchEvent(new Event('input', { bubbles: true }))
    expect(button.textContent).toBe('Queued ✓')
  })

  it('hydrates a changed live baseline when the local draft is clean', () => {
    loadSdk()
    document.body.innerHTML = '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const note = host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement
    publishSnapshot({
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Pro', note: 'First note', data: { choice: 'Pro' } },
      }],
    })

    publishSnapshot({
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Starter', note: 'Updated in drawer', data: { choice: 'Starter' } },
      }],
    })
    expect((host.querySelector('input[value="Starter"]') as HTMLInputElement).checked).toBe(true)
    expect(note.value).toBe('Updated in drawer')
    expect(host.querySelector('button')?.textContent).toBe('Queued ✓')
  })

  it('preserves a dirty local draft across a changed server baseline', () => {
    loadSdk()
    document.body.innerHTML = '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro,Enterprise"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    const note = host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement
    publishSnapshot({
      version: 1,
      controls: [{ queueKey: 'plan', response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } } }],
    })
    ;(host.querySelector('input[value="Starter"]') as HTMLInputElement).click()
    note.value = 'Local draft'
    note.dispatchEvent(new Event('input', { bubbles: true }))

    publishSnapshot({
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Enterprise', note: 'Server note', data: { choice: 'Enterprise' } },
      }],
    })
    expect((host.querySelector('input[value="Starter"]') as HTMLInputElement).checked).toBe(true)
    expect(note.value).toBe('Local draft')
    expect(host.querySelector('button')?.textContent).toBe('Update queued answer')
    expect(host.querySelector('.redline-queued-badge')?.textContent).toBe('Changed since queued')
  })

  it('uses queueKey before selector and selector fallback only for unkeyed controls', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-choice id="keyed" key="plan" prompt="Keyed" options="A,B"></redline-choice>
      <redline-choice id="unkeyed" prompt="Unkeyed" options="A,B"></redline-choice>`
    const keyed = document.querySelector('#keyed') as HTMLElement
    const unkeyed = document.querySelector('#unkeyed') as HTMLElement

    publishSnapshot({
      version: 1,
      controls: [
        { queueKey: 'other', selector: '#keyed', response: { question: 'Keyed', answer: 'A', data: { choice: 'A' } } },
        { selector: '#unkeyed', response: { question: 'Unkeyed', answer: 'B', data: { choice: 'B' } } },
      ],
    })
    expect(keyed.querySelector('input:checked')).toBeNull()
    expect(keyed.querySelector('button')?.textContent).toBe('Queue answer')
    expect((unkeyed.querySelector('input[value="B"]') as HTMLInputElement).checked).toBe(true)
    expect(unkeyed.querySelector('button')?.textContent).toBe('Queued ✓')

    publishSnapshot({
      version: 1,
      controls: [{ queueKey: 'plan', selector: '#wrong', response: { question: 'Keyed', answer: 'B', data: { choice: 'B' } } }],
    })
    expect((keyed.querySelector('input[value="B"]') as HTMLInputElement).checked).toBe(true)
    expect(keyed.querySelector('button')?.textContent).toBe('Queued ✓')
  })

  it('clears a removed baseline without erasing the draft, then hydrates on re-add', () => {
    loadSdk()
    document.body.innerHTML = '<redline-choice key="plan" prompt="Which plan?" options="Starter,Pro"></redline-choice>'
    const host = document.querySelector('redline-choice') as HTMLElement
    publishSnapshot({
      version: 1,
      controls: [{ queueKey: 'plan', response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } } }],
    })
    ;(host.querySelector('input[value="Starter"]') as HTMLInputElement).click()
    expect(host.querySelector('button')?.textContent).toBe('Update queued answer')

    publishSnapshot({ version: 1, controls: [] })
    expect((host.querySelector('input[value="Starter"]') as HTMLInputElement).checked).toBe(true)
    expect(host.querySelector('button')?.textContent).toBe('Queue answer')
    expect(host.querySelector('.redline-queued-badge')).toBeNull()

    publishSnapshot({
      version: 1,
      controls: [{
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Pro', note: 'Restored note', data: { choice: 'Pro' } },
      }],
    })
    expect((host.querySelector('input[value="Pro"]') as HTMLInputElement).checked).toBe(true)
    expect((host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement).value).toBe('Restored note')
    expect(host.querySelector('button')?.textContent).toBe('Queued ✓')
  })

  it('waits for a live snapshot after queueing instead of marking optimistically', () => {
    const calls = loadSdk()
    document.body.innerHTML = '<redline-ask key="name" prompt="Name?"></redline-ask>'
    const host = document.querySelector('redline-ask') as HTMLElement
    const answer = host.querySelector('textarea:not([data-redline-note])') as HTMLTextAreaElement
    const button = host.querySelector('button') as HTMLButtonElement
    answer.value = 'Redline'
    button.click()
    expect(calls).toHaveLength(1)
    expect(button.textContent).toBe('Queue answer')

    publishSnapshot({
      version: 1,
      controls: [{ queueKey: 'name', response: { question: 'Name?', answer: 'Redline' } }],
    })
    expect(button.textContent).toBe('Queued ✓')
  })

  it('hydrates legacy approve comments into the note field', () => {
    loadSdk()
    document.body.innerHTML = '<redline-approve key="hero" prompt="Hero?"></redline-approve>'
    const host = document.querySelector('redline-approve') as HTMLElement
    publishSnapshot({
      version: 1,
      controls: [{
        queueKey: 'hero',
        response: { question: 'Hero?', answer: 'reject — too loud', data: { verdict: 'reject', comment: 'too loud' } },
      }],
    })
    expect((host.querySelector('input[value="reject"]') as HTMLInputElement).checked).toBe(true)
    expect((host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement).value).toBe('too loud')
    expect(host.querySelector('button')?.textContent).toBe('Queued ✓')
  })
})

describe('redline-lightbox', () => {
  it('opens a figure image with its caption and restores focus on Escape', () => {
    loadSdk()
    document.body.innerHTML = `
      <figure>
        <redline-lightbox>
          <img src="expanded.png" alt="Expanded whole-session update sheet">
        </redline-lightbox>
        <figcaption><strong>Expanded: whole-session handoff</strong><p>Preserves source pane IDs.</p></figcaption>
      </figure>`
    const image = document.querySelector('redline-lightbox img') as HTMLImageElement
    expect(image.getAttribute('role')).toBe('button')
    expect(image.getAttribute('aria-haspopup')).toBe('dialog')
    expect(image.tabIndex).toBe(0)

    image.focus()
    image.click()
    const dialog = document.querySelector('dialog.redline-lightbox-dialog') as HTMLDialogElement
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.getAttribute('aria-label')).toBe('Expanded whole-session update sheet')
    expect((dialog.querySelector('.redline-lightbox-image') as HTMLImageElement).src).toContain('/expanded.png')
    expect(dialog.querySelector('.redline-lightbox-caption')?.innerHTML).toContain(
      '<strong>Expanded: whole-session handoff</strong>',
    )
    expect(dialog.querySelector('.redline-lightbox-caption')?.textContent).toContain('Preserves source pane IDs.')
    expect(dialog.querySelector('.redline-lightbox-count')?.textContent).toBe('1 / 1')
    expect(document.documentElement.style.overflow).toBe('hidden')

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(dialog.hasAttribute('open')).toBe(false)
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.activeElement).toBe(image)
  })

  it('opens from the keyboard and toggles between fit and intrinsic size', () => {
    loadSdk()
    document.body.innerHTML = '<redline-lightbox caption="Annotated terminal"><img src="terminal.png"></redline-lightbox>'
    const image = document.querySelector('redline-lightbox img') as HTMLImageElement
    image.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

    const dialog = document.querySelector('dialog.redline-lightbox-dialog') as HTMLDialogElement
    const stage = dialog.querySelector('.redline-lightbox-stage') as HTMLElement
    const sizeButton = dialog.querySelector('.redline-lightbox-size') as HTMLButtonElement
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.querySelector('.redline-lightbox-caption')?.textContent).toBe('Annotated terminal')
    expect(stage.dataset.fit).toBe('true')

    sizeButton.click()
    expect(stage.dataset.fit).toBe('false')
    expect(sizeButton.textContent).toBe('Fit to window')
    expect(sizeButton.getAttribute('aria-pressed')).toBe('true')
    sizeButton.click()
    expect(stage.dataset.fit).toBe('true')
    expect(sizeButton.textContent).toBe('Actual size')
  })

  it('cycles all page lightboxes in document order with controls and arrow keys', () => {
    loadSdk()
    document.body.innerHTML = `
      <figure>
        <redline-lightbox><img src="collapsed.png" alt="Collapsed view"></redline-lightbox>
        <figcaption><strong>Collapsed</strong></figcaption>
      </figure>
      <figure>
        <redline-lightbox><img src="expanded.png" alt="Expanded view"></redline-lightbox>
        <figcaption><strong>Expanded</strong></figcaption>
      </figure>`
    ;(document.querySelector('redline-lightbox img') as HTMLImageElement).click()
    const dialog = document.querySelector('dialog.redline-lightbox-dialog') as HTMLDialogElement
    const modalImage = dialog.querySelector('.redline-lightbox-image') as HTMLImageElement
    const count = dialog.querySelector('.redline-lightbox-count') as HTMLElement

    ;(dialog.querySelector('.redline-lightbox-next') as HTMLButtonElement).click()
    expect(modalImage.alt).toBe('Expanded view')
    expect(count.textContent).toBe('2 / 2')
    expect(dialog.querySelector('.redline-lightbox-caption')?.textContent).toContain('Expanded')

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(modalImage.alt).toBe('Collapsed view')
    expect(count.textContent).toBe('1 / 2')
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(modalImage.alt).toBe('Expanded view')
    expect(count.textContent).toBe('2 / 2')
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

describe('redline-nav', () => {
  it('builds structural links from labeled sections', async () => {
    loadSdk()
    document.body.innerHTML = `
      <div class="redline-layout">
        <redline-nav
          eyebrow="VIV-550"
          heading="Chat actor evidence"
          summary="Local proof across each surface."
          status="Verified locally"
        ></redline-nav>
        <main>
          <section id="browser" data-redline-section data-redline-label="Browser exchange"><h2>Browser</h2></section>
          <section id="fitdo" data-redline-section><h2>Fitdo exchange</h2></section>
        </main>
      </div>`
    await Promise.resolve()

    const nav = document.querySelector('redline-nav') as HTMLElement
    expect(nav.querySelector('.redline-nav-eyebrow')?.textContent).toBe('VIV-550')
    expect(nav.querySelector('.redline-nav-heading')?.textContent).toBe('Chat actor evidence')
    expect(nav.querySelector('.redline-nav-summary')?.textContent).toBe('Local proof across each surface.')
    expect(nav.querySelector('.redline-nav-status')?.textContent).toBe('Verified locally')
    expect(nav.querySelector('nav')?.getAttribute('aria-label')).toBe('Artifact sections')
    const links = [...nav.querySelectorAll('a')]
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Browser exchange', '#browser'],
      ['Fitdo exchange', '#fitdo'],
    ])
    expect(links[0]?.getAttribute('aria-current')).toBe('location')
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
    expect(styles[0].textContent).toContain('.redline-options-single label:has(:checked)')
    expect(styles[0].textContent).toContain('.redline-options-multiple label:has(:checked)')
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
