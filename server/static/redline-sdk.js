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
  const PENDING_SNAPSHOT = '__commandoRedlinePendingSnapshot'
  const PENDING_EVENT = 'commando:redline-pending'

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
    if (typeof input.note === 'string' && input.note.length > 0) {
      payload.note = input.note.slice(0, 1024)
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
  display: block; position: relative; isolation: isolate; overflow: hidden;
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
:where(redline-choice) :where(.redline-options label) {
  display: inline-flex; align-items: center; gap: .48rem; min-height: 2.75rem; box-sizing: border-box;
}
:where(redline-choice) :where(.redline-options label)::before {
  content: ""; display: inline-grid; flex: 0 0 1.05rem; width: 1.05rem; height: 1.05rem;
  place-items: center; box-sizing: border-box;
  border: 1.5px solid color-mix(in oklab, currentColor 55%, transparent);
  transition: border-color .14s ease, background .14s ease, box-shadow .14s ease;
}
:where(redline-choice) :where(.redline-options-single label)::before {
  border-radius: 50%;
}
:where(redline-choice) :where(.redline-options-multiple label)::before {
  border-radius: 4px;
}
:where(redline-choice) :where(.redline-options-single label:has(:checked))::before {
  border-color: rgb(255 255 255 / .92);
  background: radial-gradient(circle, #fff 0 27%, transparent 31%);
}
:where(redline-choice) :where(.redline-options-multiple label:has(:checked))::before {
  content: "✓"; border-color: rgb(255 255 255 / .92); color: #fff;
  background: rgb(255 255 255 / .16); font-size: .78rem; font-weight: 800; line-height: 1;
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
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(input:not([type="checkbox"]):not([type="radio"]), select) {
  display: inline-block; box-sizing: border-box;
  padding: .35rem .6rem; border-radius: 8px;
  font: inherit; color: inherit; outline: none;
  background: color-mix(in oklab, currentColor 6%, transparent);
  border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  transition: border-color .14s ease, box-shadow .14s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(input:not([type="checkbox"]):not([type="radio"]):focus, select:focus) {
  border-color: var(--_ac);
  box-shadow: 0 0 18px color-mix(in oklab, var(--_ac) 30%, transparent);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(input[type="checkbox"]:not(.redline-options *), input[type="radio"]:not(.redline-options *)) {
  accent-color: var(--_ac);
}
:where(redline-question) :where(label) {
  display: inline-flex; align-items: center; gap: .4rem; margin: 0 .9rem .5rem 0;
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
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(button.redline-queue[data-changed]) {
  background: linear-gradient(135deg, #d99124, #b86d18);
  box-shadow: 0 0 16px rgb(217 145 36 / .35), inset 0 1px 0 rgb(255 255 255 / .25);
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-queued-badge) {
  display: inline-block; margin-left: .6rem; padding: .22rem .6rem; border-radius: 999px;
  font-size: .75rem; font-weight: 600; color: #2fbf71;
  background: color-mix(in oklab, #2fbf71 14%, transparent);
  border: 1px solid color-mix(in oklab, #2fbf71 40%, transparent);
  animation: redline-badge-in .25s ease;
}
:where(redline-choice, redline-approve, redline-rating, redline-ask, redline-question) :where(.redline-queued-badge[data-changed]) {
  color: #d99124;
  background: color-mix(in oklab, #d99124 14%, transparent);
  border-color: color-mix(in oklab, #d99124 40%, transparent);
}
@keyframes redline-badge-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
:where(redline-lightbox) {
  display: block;
}
:where(redline-lightbox img[role="button"]) {
  cursor: zoom-in;
}
:where(redline-lightbox img[role="button"]:focus-visible) {
  outline: 3px solid var(--redline-accent, #7c6cf6);
  outline-offset: 4px;
}
:where(dialog.redline-lightbox-dialog) {
  --_ac: var(--redline-accent, #7c6cf6);
  position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none;
  margin: 0; padding: 0; overflow: hidden; border: 0; color: #f5f3fa;
  background: rgb(8 6 16 / .97);
}
:where(dialog.redline-lightbox-dialog::backdrop) {
  background: rgb(8 6 16 / .92);
  backdrop-filter: blur(10px);
}
:where(.redline-lightbox-frame) {
  position: relative; display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
}
:where(.redline-lightbox-bar) {
  z-index: 2; display: flex; min-width: 0; align-items: center; justify-content: space-between;
  gap: 1rem; padding: max(.75rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) .75rem max(1rem, env(safe-area-inset-left));
  border-bottom: 1px solid rgb(255 255 255 / .12); background: rgb(8 6 16 / .82);
  font: 600 .82rem/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:where(.redline-lightbox-actions) {
  display: flex; align-items: center; gap: .5rem;
}
:where(.redline-lightbox-dialog button) {
  min-height: 2.3rem; padding: .45rem .8rem; border: 1px solid rgb(255 255 255 / .18);
  border-radius: .6rem; color: #f5f3fa; background: rgb(255 255 255 / .08);
  font: 650 .8rem/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer;
}
:where(.redline-lightbox-dialog button:hover:not(:disabled)) {
  border-color: var(--_ac); background: color-mix(in oklab, var(--_ac) 22%, transparent);
}
:where(.redline-lightbox-dialog button:focus-visible) {
  outline: 2px solid var(--_ac); outline-offset: 2px;
}
:where(.redline-lightbox-dialog button:disabled) {
  visibility: hidden;
}
:where(.redline-lightbox-stage) {
  min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain;
  scrollbar-color: rgb(255 255 255 / .28) transparent;
}
:where(.redline-lightbox-canvas) {
  display: grid; width: 100%; height: 100%; min-width: 100%; min-height: 100%; place-items: center;
  padding: 1.25rem 4.5rem;
}
:where(.redline-lightbox-image) {
  display: block; max-width: 100%; max-height: 100%; object-fit: contain;
  box-shadow: 0 24px 80px rgb(0 0 0 / .58); user-select: none;
}
:where(.redline-lightbox-stage[data-fit="false"] .redline-lightbox-canvas) {
  width: max-content; height: max-content;
}
:where(.redline-lightbox-stage[data-fit="false"] .redline-lightbox-image) {
  max-width: none; max-height: none;
}
:where(.redline-lightbox-previous, .redline-lightbox-next) {
  position: absolute; z-index: 3; top: 50%; transform: translateY(-50%);
  box-shadow: 0 10px 35px rgb(0 0 0 / .45);
}
:where(.redline-lightbox-previous) { left: 1rem; }
:where(.redline-lightbox-next) { right: 1rem; }
:where(.redline-lightbox-caption) {
  z-index: 2; max-height: 24dvh; padding: .9rem max(1rem, env(safe-area-inset-right)) max(.9rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  overflow: auto; border-top: 1px solid rgb(255 255 255 / .12); background: rgb(8 6 16 / .88);
  color: #c6c0d6; font: 400 .86rem/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:where(.redline-lightbox-caption[hidden]) { display: none; }
:where(.redline-lightbox-caption > :first-child) { margin-top: 0; }
:where(.redline-lightbox-caption > :last-child) { margin-bottom: 0; }
:where(.redline-lightbox-caption strong) { color: #f5f3fa; }
@media (max-width: 640px) {
  :where(.redline-lightbox-canvas) { padding: .75rem; }
  :where(.redline-lightbox-previous, .redline-lightbox-next) { top: auto; bottom: calc(1rem + env(safe-area-inset-bottom)); }
  :where(.redline-lightbox-previous) { left: 1rem; }
  :where(.redline-lightbox-next) { right: 1rem; }
  :where(.redline-lightbox-caption:not([hidden])) { padding-bottom: calc(4.4rem + env(safe-area-inset-bottom)); }
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
    button.dataset.defaultLabel = label || 'Queue answer'
    button.textContent = button.dataset.defaultLabel
    if (!bindingAvailable()) {
      button.disabled = true
      button.title = 'Open this page in a commando tile to queue answers'
      armButtonForBinding(button)
    }
    return button
  }

  const noteInput = () => {
    const note = document.createElement('textarea')
    note.className = 'redline-comment redline-note'
    note.dataset.redlineNote = '1'
    note.placeholder = 'Optional note'
    note.maxLength = 1024
    return note
  }

  const pendingControls = new Set()
  let pendingSnapshot = null

  const validPendingSnapshot = (value) =>
    value && value.version === 1 && Array.isArray(value.controls)

  const currentPendingSnapshot = () => {
    const cached = window[PENDING_SNAPSHOT]
    return validPendingSnapshot(cached) ? cached : pendingSnapshot
  }

  const matchedPendingControl = (host, snapshot) => {
    if (!snapshot) return null
    const queueKey = host.key()
    if (queueKey) {
      return snapshot.controls.find((control) => control?.queueKey === queueKey) || null
    }
    const selector = cssPath(host)
    return snapshot.controls.find((control) => !control?.queueKey && control?.selector === selector) || null
  }

  const pendingBaseline = (response) => JSON.stringify([
    typeof response?.answer === 'string' ? response.answer.trim() : '',
    typeof response?.note === 'string' ? response.note.trim() : '',
  ])

  const renderPendingState = (host) => {
    const button = host._queueButton
    if (!button) return
    let badge = host.querySelector('.redline-queued-badge')
    if (host._queuedBaseline === null) {
      button.textContent = button.dataset.defaultLabel
      delete button.dataset.queued
      delete button.dataset.changed
      badge?.remove()
      return
    }
    const draft = host.draft()
    const matches = draft && pendingBaseline(draft) === host._queuedBaseline
    button.textContent = matches ? 'Queued ✓' : 'Update queued answer'
    if (matches) {
      button.dataset.queued = '1'
      delete button.dataset.changed
    } else {
      button.dataset.changed = '1'
      delete button.dataset.queued
    }
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'redline-queued-badge'
      button.after(badge)
    }
    badge.textContent = matches ? 'queued — see tile footer' : 'Changed since queued'
    if (matches) delete badge.dataset.changed
    else badge.dataset.changed = '1'
  }

  const applyPendingSnapshot = (snapshot) => {
    if (!validPendingSnapshot(snapshot)) return
    pendingSnapshot = snapshot
    for (const control of pendingControls) control.applyPendingSnapshot(snapshot)
  }

  window.addEventListener(PENDING_EVENT, (event) => {
    const snapshot = validPendingSnapshot(event.detail) ? event.detail : window[PENDING_SNAPSHOT]
    applyPendingSnapshot(snapshot)
  })

  const promptHeading = (host) => {
    const heading = document.createElement('p')
    heading.className = 'redline-prompt'
    heading.textContent = host.getAttribute('prompt') || ''
    return heading
  }

  /** Shared base: light-DOM render on connect, one queue press per answer. */
  class RedlineElement extends HTMLElement {
    connectedCallback() {
      if (this.dataset.redlineReady) {
        this.registerPendingControl()
        return
      }
      this.dataset.redlineReady = '1'
      // Custom-element upgrade fires connectedCallback at the OPENING tag when
      // the SDK loads synchronously (e.g. from <head>) — the parser hasn't
      // reached this element's children yet. Rendering now would build our
      // markup before the author's content exists (RedlineQuestion prepends
      // the heading and appends the button around content that isn't there
      // yet). Defer to DOMContentLoaded so children are parsed first; once
      // the document is no longer 'loading' (or in tests, where innerHTML
      // parses the whole subtree upfront) children are already present and
      // render() runs immediately as before.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.render(), { once: true })
      } else {
        this.render()
      }
    }
    disconnectedCallback() {
      pendingControls.delete(this)
    }
    key() {
      return this.getAttribute('key') || undefined
    }
    prompt() {
      return this.getAttribute('prompt') || this.getAttribute('key') || 'Question'
    }
    queue(answer, data) {
      return queueResponse({
        question: this.prompt(),
        answer,
        note: this._noteInput?.value.trim() || undefined,
        data,
        queueKey: this.key(),
        element: this,
      })
    }
    finishRender(button, note) {
      this._queueButton = button
      this._noteInput = note
      this._queuedBaseline = null
      this.addEventListener('input', () => renderPendingState(this))
      this.addEventListener('change', () => renderPendingState(this))
      this.registerPendingControl()
    }
    registerPendingControl() {
      if (!this._queueButton || !this.isConnected) return
      pendingControls.add(this)
      const snapshot = currentPendingSnapshot()
      if (snapshot) this.applyPendingSnapshot(snapshot)
    }
    applyPendingSnapshot(snapshot) {
      const currentDraft = this.draft()
      const wasClean = this._queuedBaseline === null || (
        currentDraft && pendingBaseline(currentDraft) === this._queuedBaseline
      )
      const control = matchedPendingControl(this, snapshot)
      if (!control?.response) {
        this._queuedBaseline = null
        renderPendingState(this)
        return
      }
      if (wasClean) {
        this.hydrate(control.response)
        const restoredNote = typeof control.response.note === 'string'
          ? control.response.note
          : this.legacyNote(control.response)
        this._noteInput.value = restoredNote || ''
      }
      this._queuedBaseline = pendingBaseline(this.baseline(control.response))
      renderPendingState(this)
    }
    baseline(response) {
      return {
        answer: response.answer,
        note: typeof response.note === 'string' ? response.note : this.legacyNote(response),
      }
    }
    legacyNote() { return '' }
    hydrate() {}
    draft() { return null }
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
      list.className = `redline-options redline-options-${multiple ? 'multiple' : 'single'}`
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
      const note = noteInput()
      button.addEventListener('click', () => {
        const chosen = [...this.querySelectorAll('input:checked')].map((input) => input.value)
        if (chosen.length === 0) return
        this.queue(chosen.join(', '), { choice: multiple ? chosen : chosen[0] })
      })
      this.append(list, note, button)
      this._multiple = multiple
      this.finishRender(button, note)
    }
    hydrate(response) {
      const choice = response.data?.choice
      const values = Array.isArray(choice)
        ? choice.map(String)
        : typeof choice === 'string'
          ? [choice]
          : this._multiple
            ? response.answer.split(', ').map((value) => value.trim())
            : [response.answer]
      for (const input of this.querySelectorAll('.redline-options input')) {
        input.checked = values.includes(input.value)
      }
    }
    draft() {
      const chosen = [...this.querySelectorAll('.redline-options input:checked')].map((input) => input.value)
      if (chosen.length === 0) return null
      return { answer: chosen.join(', '), note: this._noteInput.value }
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
      const note = noteInput()
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        this.queue(selected.value, { verdict: selected.value })
      })
      this.append(list, note, button)
      this.finishRender(button, note)
    }
    legacyNote(response) {
      return typeof response.data?.comment === 'string' ? response.data.comment : ''
    }
    baseline(response) {
      return {
        answer: typeof response.data?.verdict === 'string' ? response.data.verdict : response.answer.split(' — ')[0],
        note: typeof response.note === 'string' ? response.note : this.legacyNote(response),
      }
    }
    hydrate(response) {
      const verdict = typeof response.data?.verdict === 'string'
        ? response.data.verdict
        : response.answer.split(' — ')[0]
      for (const input of this.querySelectorAll('.redline-options input')) input.checked = input.value === verdict
    }
    draft() {
      const selected = this.querySelector('.redline-options input:checked')
      return selected ? { answer: selected.value, note: this._noteInput.value } : null
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
      const note = noteInput()
      button.addEventListener('click', () => {
        const selected = this.querySelector('input:checked')
        if (!selected) return
        this.queue(`${selected.value}/${max}`, { rating: Number(selected.value), max })
      })
      this.append(list, note, button)
      this._max = max
      this.finishRender(button, note)
    }
    hydrate(response) {
      const rating = response.data?.rating ?? String(response.answer).split('/')[0]
      for (const input of this.querySelectorAll('.redline-options input')) input.checked = input.value === String(rating)
    }
    draft() {
      const selected = this.querySelector('.redline-options input:checked')
      return selected ? { answer: `${selected.value}/${this._max}`, note: this._noteInput.value } : null
    }
  }

  class RedlineAsk extends RedlineElement {
    render() {
      this.append(promptHeading(this))
      const input = document.createElement('textarea')
      input.className = 'redline-comment'
      input.placeholder = this.getAttribute('placeholder') || 'Your answer'
      const note = noteInput()
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const answer = input.value.trim()
        if (!answer) return
        this.queue(answer)
      })
      this.append(input, note, button)
      this._answerInput = input
      this.finishRender(button, note)
    }
    hydrate(response) {
      this._answerInput.value = response.answer
    }
    draft() {
      const answer = this._answerInput.value.trim()
      return answer ? { answer, note: this._noteInput.value } : null
    }
  }

  class RedlineQuestion extends RedlineElement {
    render() {
      // Wraps author-provided native inputs; only adds the heading + button.
      this.prepend(promptHeading(this))
      const note = noteInput()
      const button = queueButton(this.getAttribute('button-label'))
      button.addEventListener('click', () => {
        const draft = this.structuredDraft()
        if (!draft) return
        this.queue(draft.answer, draft.data)
      })
      this.append(note, button)
      this.finishRender(button, note)
    }
    authoredFields() {
      return [...this.querySelectorAll('input, select, textarea')]
        .filter((field) => !field.matches('[data-redline-note]'))
    }
    structuredDraft() {
      const data = {}
      const parts = []
      for (const field of this.authoredFields()) {
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
      return parts.length === 0 ? null : { answer: parts.join('; ').slice(0, 1024), data }
    }
    hydrate(response) {
      const data = response.data && typeof response.data === 'object' ? response.data : Object.fromEntries(
        String(response.answer).split('; ').map((part) => {
          const separator = part.indexOf(': ')
          return separator < 0 ? ['', ''] : [part.slice(0, separator), part.slice(separator + 2)]
        }),
      )
      for (const field of this.authoredFields()) {
        const key = field.name || field.id
        if (!key || !Object.prototype.hasOwnProperty.call(data, key)) continue
        const value = data[key]
        if (field.type === 'checkbox') field.checked = value === true || value === 'yes'
        else if (field.type === 'radio') field.checked = field.value === String(value)
        else field.value = String(value)
      }
    }
    draft() {
      const draft = this.structuredDraft()
      return draft ? { answer: draft.answer, note: this._noteInput.value } : null
    }
  }

  let activeLightbox = null
  let lightboxDialog = null
  let lightboxReturnFocus = null
  let previousDocumentOverflow = ''

  const lightboxCaption = (host) => {
    const ownCaption = host.querySelector('figcaption, [data-redline-lightbox-caption]')
    if (ownCaption) return ownCaption
    const figure = host.closest('figure')
    return figure?.querySelector('figcaption, [data-redline-lightbox-caption]') || null
  }

  const lightboxHosts = () =>
    [...document.querySelectorAll('redline-lightbox')].filter((host) => host.querySelector('img'))

  const finishLightboxClose = () => {
    if (!activeLightbox) return
    activeLightbox = null
    document.documentElement.style.overflow = previousDocumentOverflow
    const returnFocus = lightboxReturnFocus
    lightboxReturnFocus = null
    if (returnFocus?.isConnected) returnFocus.focus()
  }

  const closeLightbox = () => {
    if (!lightboxDialog?.hasAttribute('open')) return
    finishLightboxClose()
    if (typeof lightboxDialog.close === 'function') lightboxDialog.close()
    else lightboxDialog.removeAttribute('open')
  }

  const renderLightbox = (host) => {
    const image = host.querySelector('img')
    if (!image || !lightboxDialog) return
    activeLightbox = host
    const hosts = lightboxHosts()
    const index = hosts.indexOf(host)
    const modalImage = lightboxDialog.querySelector('.redline-lightbox-image')
    modalImage.src = image.currentSrc || image.src
    modalImage.alt = image.alt || ''

    const caption = lightboxCaption(host)
    const captionPanel = lightboxDialog.querySelector('.redline-lightbox-caption')
    const attributeCaption = host.getAttribute('caption')
    captionPanel.replaceChildren()
    if (caption) {
      captionPanel.append(...[...caption.childNodes].map((node) => node.cloneNode(true)))
      captionPanel.hidden = false
    } else if (attributeCaption) {
      captionPanel.textContent = attributeCaption
      captionPanel.hidden = false
    } else {
      captionPanel.hidden = true
    }

    const label = image.alt || caption?.textContent?.trim() || attributeCaption || 'Image preview'
    lightboxDialog.setAttribute('aria-label', label)
    lightboxDialog.querySelector('.redline-lightbox-count').textContent = `${index + 1} / ${hosts.length}`
    const hasMultiple = hosts.length > 1
    lightboxDialog.querySelector('.redline-lightbox-previous').disabled = !hasMultiple
    lightboxDialog.querySelector('.redline-lightbox-next').disabled = !hasMultiple
    const stage = lightboxDialog.querySelector('.redline-lightbox-stage')
    stage.dataset.fit = 'true'
    stage.scrollTo?.(0, 0)
    const sizeButton = lightboxDialog.querySelector('.redline-lightbox-size')
    sizeButton.textContent = 'Actual size'
    sizeButton.setAttribute('aria-pressed', 'false')
  }

  const moveLightbox = (direction) => {
    const hosts = lightboxHosts()
    if (hosts.length < 2 || !activeLightbox) return
    const currentIndex = hosts.indexOf(activeLightbox)
    const nextIndex = (currentIndex + direction + hosts.length) % hosts.length
    renderLightbox(hosts[nextIndex])
  }

  const ensureLightboxDialog = () => {
    if (lightboxDialog?.isConnected) return lightboxDialog
    lightboxDialog = null
    const dialog = document.createElement('dialog')
    dialog.className = 'redline-lightbox-dialog'
    dialog.innerHTML = `
      <div class="redline-lightbox-frame">
        <header class="redline-lightbox-bar">
          <span class="redline-lightbox-count" aria-live="polite"></span>
          <div class="redline-lightbox-actions">
            <button type="button" class="redline-lightbox-size" aria-pressed="false">Actual size</button>
            <button type="button" class="redline-lightbox-close">Close</button>
          </div>
        </header>
        <div class="redline-lightbox-stage" data-fit="true">
          <div class="redline-lightbox-canvas"><img class="redline-lightbox-image" alt=""></div>
        </div>
        <button type="button" class="redline-lightbox-previous" aria-label="Previous image">Previous</button>
        <button type="button" class="redline-lightbox-next" aria-label="Next image">Next</button>
        <footer class="redline-lightbox-caption"></footer>
      </div>`
    dialog.querySelector('.redline-lightbox-close').addEventListener('click', closeLightbox)
    dialog.querySelector('.redline-lightbox-previous').addEventListener('click', () => moveLightbox(-1))
    dialog.querySelector('.redline-lightbox-next').addEventListener('click', () => moveLightbox(1))
    dialog.querySelector('.redline-lightbox-size').addEventListener('click', (event) => {
      const stage = dialog.querySelector('.redline-lightbox-stage')
      const fitting = stage.dataset.fit !== 'false'
      stage.dataset.fit = fitting ? 'false' : 'true'
      event.currentTarget.textContent = fitting ? 'Fit to window' : 'Actual size'
      event.currentTarget.setAttribute('aria-pressed', fitting ? 'true' : 'false')
      if (!fitting) stage.scrollTo?.(0, 0)
    })
    dialog.addEventListener('click', (event) => {
      if (
        event.target === dialog ||
        event.target.classList?.contains('redline-lightbox-stage') ||
        event.target.classList?.contains('redline-lightbox-canvas')
      ) {
        closeLightbox()
      }
    })
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeLightbox()
    })
    dialog.addEventListener('close', finishLightboxClose)
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        moveLightbox(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        moveLightbox(1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeLightbox()
      }
    })
    document.body.append(dialog)
    lightboxDialog = dialog
    return dialog
  }

  const openLightbox = (host) => {
    const dialog = ensureLightboxDialog()
    if (!dialog.hasAttribute('open')) {
      lightboxReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      previousDocumentOverflow = document.documentElement.style.overflow
      document.documentElement.style.overflow = 'hidden'
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    renderLightbox(host)
    dialog.querySelector('.redline-lightbox-close').focus()
  }

  /** Focused image viewing with figure captions and page-wide navigation. */
  class RedlineLightbox extends HTMLElement {
    connectedCallback() {
      if (this.dataset.redlineReady) return
      this.dataset.redlineReady = '1'
      const render = () => this.render()
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render, { once: true })
      } else {
        render()
      }
    }

    disconnectedCallback() {
      if (activeLightbox === this) closeLightbox()
    }

    render() {
      const image = this.querySelector('img')
      if (!image) return
      const caption = lightboxCaption(this)
      const label = image.alt || caption?.textContent?.trim() || this.getAttribute('caption') || 'image'
      image.setAttribute('role', 'button')
      if (!image.hasAttribute('tabindex')) image.tabIndex = 0
      image.setAttribute('aria-haspopup', 'dialog')
      image.setAttribute('aria-label', `Open ${label}`)
      image.addEventListener('click', () => openLightbox(this))
      image.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openLightbox(this)
      })
    }
  }

  /** Structural navigation for authored artifacts using stable section ids. */
  class RedlineNav extends HTMLElement {
    connectedCallback() {
      if (this.dataset.redlineReady) return
      this.dataset.redlineReady = '1'
      const render = () => queueMicrotask(() => this.render())
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render, { once: true })
      } else {
        render()
      }
    }

    disconnectedCallback() {
      this._observer?.disconnect()
      this._observer = null
    }

    render() {
      const sections = [...document.querySelectorAll('[data-redline-section][id]')]
      const brand = document.createElement('div')
      brand.className = 'redline-nav-brand'

      const eyebrow = this.getAttribute('eyebrow')
      if (eyebrow) {
        const element = document.createElement('p')
        element.className = 'redline-nav-eyebrow'
        element.textContent = eyebrow
        brand.append(element)
      }

      const heading = this.getAttribute('heading')
      if (heading) {
        const element = document.createElement('h2')
        element.className = 'redline-nav-heading'
        element.textContent = heading
        brand.append(element)
      }

      const summary = this.getAttribute('summary')
      if (summary) {
        const element = document.createElement('p')
        element.className = 'redline-nav-summary'
        element.textContent = summary
        brand.append(element)
      }

      const statusText = this.getAttribute('status')
      if (statusText) {
        const status = document.createElement('p')
        status.className = 'redline-nav-status'
        status.dataset.tone = this.getAttribute('status-tone') || 'success'
        status.textContent = statusText
        brand.append(status)
      }

      const navigation = document.createElement('nav')
      navigation.className = 'redline-nav-links'
      navigation.setAttribute('aria-label', this.getAttribute('label') || 'Artifact sections')
      const links = sections.map((section) => {
        const link = document.createElement('a')
        link.href = `#${encodeURIComponent(section.id)}`
        link.textContent =
          section.getAttribute('data-redline-label') ||
          section.querySelector('h2, h3, h4')?.textContent?.trim() ||
          section.id.replace(/[-_]+/g, ' ')
        navigation.append(link)
        return link
      })

      this.replaceChildren(brand, navigation)
      if (links.length === 0) return
      const activate = (id) => {
        for (const link of links) {
          if (decodeURIComponent(link.hash.slice(1)) === id) link.setAttribute('aria-current', 'location')
          else link.removeAttribute('aria-current')
        }
      }
      activate(sections[0].id)

      if (typeof IntersectionObserver !== 'function') return
      const visible = new Map()
      this._observer = new IntersectionObserver((entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry)
        const current = [...visible.values()]
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top))[0]
        if (current) activate(current.target.id)
      }, { rootMargin: '-10% 0px -70% 0px', threshold: [0, 0.1, 0.5] })
      for (const section of sections) this._observer.observe(section)
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
  defineOnce('redline-lightbox', RedlineLightbox)
  defineOnce('redline-nav', RedlineNav)
})()
