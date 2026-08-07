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

  const bindingAvailable = () => typeof window[BINDING] === 'function'

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
    if (input.data !== undefined) payload.data = input.data
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
    try {
      window[BINDING](JSON.stringify(payload))
    } catch (error) {
      console.warn('redline: failed to queue answer', error)
      return false
    }
    return true
  }

  window.redline = Object.assign(window.redline || {}, { queueResponse })

  let uid = 0
  const nextName = () => `redline-${(uid += 1)}`

  const queueButton = (label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'redline-queue btn btn-primary btn-sm'
    button.textContent = label || 'Queue answer'
    if (!bindingAvailable()) {
      button.disabled = true
      button.title = 'Open this page in a commando tile to queue answers'
    }
    return button
  }

  const markQueued = (host, button) => {
    button.textContent = 'Queued ✓'
    let badge = host.querySelector('.redline-queued-badge')
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'redline-queued-badge badge badge-success badge-sm'
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
        input.className = multiple ? 'checkbox checkbox-sm' : 'radio radio-sm'
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
        input.className = 'radio radio-sm'
        label.append(input, document.createTextNode(` ${verdict}`))
        list.append(label)
      }
      const comment = document.createElement('textarea')
      comment.className = 'redline-comment textarea textarea-sm'
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
      list.className = 'redline-options rating'
      for (let value = 1; value <= max; value += 1) {
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = name
        input.value = String(value)
        input.className = 'mask mask-star-2'
        input.setAttribute('aria-label', `${value} of ${max}`)
        list.append(input)
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
      input.className = 'redline-comment textarea textarea-sm'
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
