/**
 * Redline component SDK — served by the commando daemon at /redline/sdk.js.
 * Plain JS on purpose: artifacts load it with one <script> tag and it must
 * work with no build step. Inside a commando chromium tile the CDP binding
 * window.__commandoRedlineQueue exists; elsewhere components render but
 * queueing is disabled.
 *
 * Discipline (matters for review UX): interacting with a control only updates
 * local state. Only the explicit queue button sends, exactly once per press,
 * and a queueKey makes re-answers replace the unsent previous answer.
 */
;(() => {
  'use strict'
  const BINDING = '__commandoRedlineQueue'

  // Mirrors shared/redline-response.ts MAX_RESPONSE_DATA_JSON — keep in sync.
  const MAX_RESPONSE_DATA_JSON = 4096
  // Mirrors shared/redline-response.ts MAX_RESPONSE_PAYLOAD_BYTES — keep in sync.
  const MAX_RESPONSE_PAYLOAD_BYTES = 16384
  // Dropped in this order, least important to the answer first, until the
  // payload fits under MAX_RESPONSE_PAYLOAD_BYTES.
  const OPTIONAL_FIELD_DROP_ORDER = ['data', 'text', 'selector', 'rect']

  const bindingAvailable = () => typeof window[BINDING] === 'function'

  // The engine starts the page navigating the moment it creates the target,
  // before it finishes wiring Runtime.addBinding — so a component can render
  // (and snapshot bindingAvailable() as false) moments before the binding
  // actually shows up. One shared poller re-arms every disabled button
  // instead of leaving that snapshot permanent; it gives up after ~15s so a
  // genuinely plain-browser page doesn't poll forever.
  const BINDING_POLL_INTERVAL_MS = 250
  const BINDING_POLL_TIMEOUT_MS = 15_000
  let bindingPollTimer = null
  let bindingPollElapsedMs = 0
  const pendingButtons = new Set()

  const stopBindingPoll = () => {
    if (bindingPollTimer) clearInterval(bindingPollTimer)
    bindingPollTimer = null
    bindingPollElapsedMs = 0
  }

  const armButtonForBinding = (button) => {
    pendingButtons.add(button)
    if (bindingPollTimer) return
    bindingPollTimer = setInterval(() => {
      if (bindingAvailable()) {
        for (const pending of pendingButtons) {
          pending.disabled = false
          pending.title = ''
        }
        pendingButtons.clear()
        stopBindingPoll()
        return
      }
      bindingPollElapsedMs += BINDING_POLL_INTERVAL_MS
      if (bindingPollElapsedMs >= BINDING_POLL_TIMEOUT_MS) {
        // Gave up — buttons stay disabled with their hint, same as a page
        // that was never opened in a commando tile at all.
        pendingButtons.clear()
        stopBindingPoll()
      }
    }, BINDING_POLL_INTERVAL_MS)
  }

  /** id → data-testid → nth-of-type path, mirroring the tile inspector. */
  const cssPath = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`
    const testId = element.getAttribute && element.getAttribute('data-testid')
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`
    const parts = []
    let node = element
    while (node && node.nodeType === 1 && parts.length < 32) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      const tag = node.tagName.toLowerCase()
      let index = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1
        sibling = sibling.previousElementSibling
      }
      parts.unshift(`${tag}:nth-of-type(${index})`)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const queueResponse = (input) => {
    if (!input || typeof input.question !== 'string' || typeof input.answer !== 'string') return false
    const payload = {
      question: input.question.slice(0, 256),
      answer: input.answer.slice(0, 1024),
    }
    if (input.data !== undefined) {
      let json
      try {
        json = JSON.stringify(input.data)
      } catch (error) {
        json = undefined
      }
      if (json !== undefined && json.length <= MAX_RESPONSE_DATA_JSON) {
        payload.data = input.data
      } else {
        // data is best-effort: drop it locally rather than fail the whole answer —
        // the daemon would drop it anyway, but this saves the round trip and
        // tells the page author immediately.
        console.warn('redline: answer data dropped (unserializable or over the size cap)', input.data)
      }
    }
    if (typeof input.queueKey === 'string' && input.queueKey.length > 0) {
      payload.queueKey = input.queueKey.slice(0, 128)
    }
    const element = input.element instanceof Element ? input.element : null
    if (element) {
      const selector = cssPath(element)
      if (selector) payload.selector = selector.slice(0, 1024)
      payload.tag = element.tagName.toLowerCase().slice(0, 32)
      const rect = element.getBoundingClientRect()
      payload.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const text = (element.textContent || '').trim()
      if (text) payload.text = text.slice(0, 512)
    }
    if (!bindingAvailable()) {
      console.warn('redline: not inside a commando tile — answer not queued', payload)
      return false
    }
    // Belt-and-suspenders: field caps above already keep a normal payload
    // well under the server limit, but if something still pushes it over,
    // drop optional fields rather than lose the queued answer.
    let serialized = JSON.stringify(payload)
    for (const field of OPTIONAL_FIELD_DROP_ORDER) {
      if (serialized.length <= MAX_RESPONSE_PAYLOAD_BYTES) break
      if (payload[field] === undefined) continue
      delete payload[field]
      console.warn(`redline: dropped "${field}" to fit the answer under the payload size cap`)
      serialized = JSON.stringify(payload)
    }
    try {
      window[BINDING](serialized)
    } catch (error) {
      console.warn('redline: failed to queue answer', error)
      return false
    }
    return true
  }

  window.redline = Object.assign(window.redline || {}, { queueResponse })

  // Aura visual treatment — self-styled, no host-page CSS kit dependency.
  // Scoped via :where() so it never out-specifies author styles.
  const AURA_CSS = `
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) {
  --_ac: var(--redline-accent, #7c6cf6);
  --_ac2: var(--redline-accent2, #5aa9f7);
  display: block; position: relative; isolation: isolate;
  margin: 1.25rem 0; padding: 1.15rem 1.25rem 1.25rem;
  border-radius: 16px;
  background: color-mix(in oklab, currentColor 5%, transparent);
  backdrop-filter: blur(14px);
  font-size: .95rem; line-height: 1.5;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question)::before {
  content: ""; position: absolute; inset: 0; border-radius: 16px; z-index: -1;
  padding: 1px; pointer-events: none;
  background: linear-gradient(135deg, color-mix(in oklab, var(--_ac) 55%, transparent),
              transparent 40%, color-mix(in oklab, var(--_ac2) 45%, transparent));
  -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
  mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question)::after {
  content: ""; position: absolute; z-index: -2; inset: 30% -10% -40% 40%;
  border-radius: 50%; pointer-events: none;
  background: radial-gradient(closest-side, color-mix(in oklab, var(--_ac) 16%, transparent), transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-prompt) {
  margin: 0 0 .85rem; font-weight: 650; letter-spacing: -.01em;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options) {
  display: inline-flex; flex-wrap: wrap; margin: 0 0 .85rem; border-radius: 10px; overflow: hidden;
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label) {
  padding: .45rem 1rem; cursor: pointer; user-select: none; transition: background .14s ease, color .14s ease;
  border-right: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:last-child) {
  border-right: 0;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:hover) {
  background: color-mix(in oklab, currentColor 7%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options label:has(:checked)) {
  background: linear-gradient(135deg, var(--_ac), var(--_ac2));
  color: #fff; font-weight: 650; text-shadow: 0 1px 4px rgb(0 0 0 / .25);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-options input) {
  position: absolute; opacity: 0; pointer-events: none;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment) {
  display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 2.6rem;
  margin: 0 0 .2rem; padding: .55rem .75rem; border-radius: 10px;
  font: inherit; font-size: .9rem; color: inherit; outline: none;
  background: color-mix(in oklab, currentColor 6%, transparent);
  border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  transition: border-color .14s ease, box-shadow .14s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment:focus) {
  border-color: var(--_ac);
  box-shadow: 0 0 18px color-mix(in oklab, var(--_ac) 30%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-comment::placeholder) {
  color: color-mix(in oklab, currentColor 45%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue) {
  margin-top: .85rem; padding: .5rem 1.15rem; cursor: pointer;
  border: 0; border-radius: 10px; font: inherit; font-size: .9rem; font-weight: 650; color: #fff;
  background: linear-gradient(135deg, var(--_ac), var(--_ac2));
  box-shadow: 0 0 20px color-mix(in oklab, var(--_ac) 40%, transparent), inset 0 1px 0 rgb(255 255 255 / .25);
  transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue:hover:not(:disabled)) {
  transform: translateY(-1px);
  box-shadow: 0 0 28px color-mix(in oklab, var(--_ac) 55%, transparent), inset 0 1px 0 rgb(255 255 255 / .3);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue:disabled) {
  cursor: not-allowed; filter: grayscale(.7) opacity(.55); box-shadow: none;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue[data-queued]) {
  background: linear-gradient(135deg, #2fbf71, #24a05c);
  box-shadow: 0 0 16px rgb(47 191 113 / .35), inset 0 1px 0 rgb(255 255 255 / .25);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-queued-badge) {
  display: inline-block; margin-left: .6rem; padding: .22rem .6rem; border-radius: 999px;
  font-size: .75rem; font-weight: 600; color: #2fbf71;
  background: color-mix(in oklab, #2fbf71 14%, transparent);
  border: 1px solid color-mix(in oklab, #2fbf71 40%, transparent);
  animation: redline-badge-in .25s ease;
}
@keyframes redline-badge-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
`

  const injectStyles = () => {
    if (document.head.querySelector('style[data-redline-styles]')) return
    const style = document.createElement('style')
    style.setAttribute('data-redline-styles', '')
    style.textContent = AURA_CSS
    document.head.append(style)
  }
  injectStyles()

  let uid = 0
  const nextName = () => `redline-${(uid += 1)}`

  const queueButton = (label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'redline-queue'
    button.textContent = label || 'Queue answer'
    if (!bindingAvailable()) {
      button.disabled = true
      button.title = 'Open this page in a commando tile to queue answers'
      armButtonForBinding(button)
    }
    return button
  }

  const markQueued = (host, button) => {
    button.textContent = 'Queued ✓'
    button.dataset.queued = '1'
    let badge = host.querySelector('.redline-queued-badge')
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'redline-queued-badge'
      badge.textContent = 'queued — see tile footer'
      button.after(badge)
    }
  }

  const promptHeading = (host) => {
    const heading = document.createElement('p')
    heading.className = 'redline-prompt'
    heading.textContent = host.getAttribute('prompt') || ''
    return heading
  }

  /** Shared base: light-DOM render on connect, one queue press per answer. */
  class RedlineElement extends HTMLElement {
    connectedCallback() {
      if (this.dataset.redlineReady) return
      this.dataset.redlineReady = '1'
      this.render()
    }
    key() {
      return this.getAttribute('key') || undefined
    }
    prompt() {
      return this.getAttribute('prompt') || this.getAttribute('key') || 'Question'
    }
    queue(answer, data) {
      const sent = queueResponse({
        question: this.prompt(),
        answer,
        data,
        queueKey: this.key(),
        element: this,
      })
      if (sent) markQueued(this, this.querySelector('button.redline-queue'))
      return sent
    }
    render() {}
  }

  class RedlineChoice extends RedlineElement {
    render() {
      const multiple = this.hasAttribute('multiple')
      const name = nextName()
      const options = (this.getAttribute('options') || '')
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean)
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options'
      for (const option of options) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = multiple ? 'checkbox' : 'radio'
        input.name = name
        input.value = option
        label.append(input, document.createTextNode(` ${option}`))
        list.append(label)
      }
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const chosen = [...this.querySelectorAll('input:checked')].map((input) => input.value)
        if (chosen.length === 0) return
        this.queue(chosen.join(', '), { choice: multiple ? chosen : chosen[0] })
      })
      this.append(list, button)
    }
  }

  class RedlineApprove extends RedlineElement {
    render() {
      const name = nextName()
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options'
      for (const verdict of ['approve', 'reject', 'needs-changes']) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = name
        input.value = verdict
        label.append(input, document.createTextNode(` ${verdict}`))
        list.append(label)
      }
      const comment = document.createElement('textarea')
      comment.className = 'redline-comment'
      comment.placeholder = 'Optional comment'
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        const note = comment.value.trim()
        this.queue(note ? `${selected.value} — ${note}` : selected.value, {
          verdict: selected.value,
          ...(note ? { comment: note } : {}),
        })
      })
      this.append(list, comment, button)
    }
  }

  class RedlineRating extends RedlineElement {
    render() {
      const name = nextName()
      const max = Math.min(Math.max(Number(this.getAttribute('max')) || 5, 2), 10)
      this.append(promptHeading(this))
      const list = document.createElement('div')
      list.className = 'redline-options'
      for (let value = 1; value <= max; value += 1) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = name
        input.value = String(value)
        input.setAttribute('aria-label', `${value} of ${max}`)
        const span = document.createElement('span')
        span.textContent = String(value)
        label.append(input, span)
        list.append(label)
      }
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        this.queue(`${selected.value}/${max}`, { rating: Number(selected.value), max })
      })
      this.append(list, button)
    }
  }

  class RedlineAsk extends RedlineElement {
    render() {
      this.append(promptHeading(this))
      const input = document.createElement('textarea')
      input.className = 'redline-comment'
      input.placeholder = this.getAttribute('placeholder') || 'Your answer'
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const answer = input.value.trim()
        if (!answer) return
        this.queue(answer)
      })
      this.append(input, button)
    }
  }

  class RedlineQuestion extends RedlineElement {
    render() {
      // Wraps author-provided native inputs; only adds the heading + button.
      this.prepend(promptHeading(this))
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const data = {}
        const parts = []
        for (const field of this.querySelectorAll('input, select, textarea')) {
          const key = field.name || field.id
          if (!key) continue
          if (field.type === 'checkbox') {
            data[key] = field.checked
            parts.push(`${key}: ${field.checked ? 'yes' : 'no'}`)
          } else if (field.type === 'radio') {
            if (!field.checked) continue
            data[key] = field.value
            parts.push(`${key}: ${field.value}`)
          } else {
            data[key] = field.value
            parts.push(`${key}: ${field.value}`)
          }
        }
        if (parts.length === 0) return
        this.queue(parts.join('; ').slice(0, 1024), data)
      })
      this.append(button)
    }
  }

  // Guard against redefinition: the registry throws if this script ends up on
  // a page twice (or is re-evaluated, as tests do), and the tag names are the
  // only externally-visible contract — same name, same behavior, no reason to fail.
  const defineOnce = (name, Ctor) => {
    if (!customElements.get(name)) customElements.define(name, Ctor)
  }
  defineOnce('redline-choice', RedlineChoice)
  defineOnce('redline-approve', RedlineApprove)
  defineOnce('redline-rating', RedlineRating)
  defineOnce('redline-ask', RedlineAsk)
  defineOnce('redline-question', RedlineQuestion)
})()
