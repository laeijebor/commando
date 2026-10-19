/* Canvas iframe bridge. The sandbox has an opaque origin: authenticate the parent by window identity. */
;(function () {
  'use strict'
  var script = document.currentScript
  var frameId = script && script.getAttribute('data-canvas-frame')
  if (!frameId || !/^[A-Za-z0-9_-]{1,64}$/.test(frameId)) return

  function post(type, payload) {
    window.parent.postMessage(Object.assign({ source: 'commando-canvas-frame', frameId: frameId, type: type }, payload), '*')
  }
  window.__commandoRedlineQueue = function (payload) { post('redline-queue', { payload: payload }) }
  function rect(element, documentCoordinates) {
    var r = element.getBoundingClientRect()
    return { x: r.left + (documentCoordinates ? window.scrollX : 0), y: r.top + (documentCoordinates ? window.scrollY : 0), w: r.width, h: r.height }
  }
  // Use identifier escapes for both IDs and quoted attribute values.
  function escape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value)
    return Array.from(value).map(function (c, i) {
      var safe = /[a-zA-Z0-9_-]/.test(c) && value !== '-' && !(i === 0 && /[0-9]/.test(c)) && !(i === 1 && value[0] === '-' && /[0-9]/.test(c))
      return safe ? c : '\\' + c.codePointAt(0).toString(16) + ' '
    }).join('')
  }
  function anchor(element) {
    var id = element.getAttribute('data-canvas-id')
    var candidates = []
    if (id) candidates.push('[data-canvas-id="' + escape(id) + '"]')
    if (element.id) candidates.push('#' + escape(element.id))
    return candidates.find(function (candidate) { return document.querySelectorAll(candidate).length === 1 }) || null
  }
  function selector(element) {
    var path = []
    for (var node = element; node; node = node.parentElement) {
      var stable = anchor(node)
      if (stable) {
        path.unshift(stable)
        return path.join(' > ')
      }
      var tag = node.localName
      var siblings = node.parentElement ? Array.from(node.parentElement.children).filter(function (s) { return s.localName === tag }) : [node]
      path.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''))
      var candidate = path.join(' > ')
      if (document.querySelectorAll(candidate).length === 1) return candidate
    }
    return path.join(' > ')
  }
  function validRect(item) {
    return Object.keys(item.rect).every(function (k) { return Number.isFinite(item.rect[k]) && Math.abs(item.rect[k]) <= 1000000 }) && item.rect.w >= 0 && item.rect.h >= 0
  }
  // The part of a control a reviewer can see: inside scroll/clip ancestors and the viewport, not covered by an overlay.
  function visibleRect(element) {
    if (element.matches(':disabled')) return null // browsers drop its clicks
    var style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return null
    var r = element.getBoundingClientRect()
    var left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight)
    // body/html overflow applies to the viewport (already clipped above), not their own boxes.
    for (var node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      var ancestor = getComputedStyle(node)
      if (ancestor.opacity === '0') return null
      if (!/auto|scroll|hidden|clip/.test(ancestor.overflow + ancestor.overflowX + ancestor.overflowY)) continue
      var c = node.getBoundingClientRect()
      left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom)
    }
    if (right <= left || bottom <= top) return null
    var hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    if (hit && hit !== element && !element.contains(hit)) return null
    return { x: left, y: top, w: right - left, h: bottom - top }
  }
  function report() {
    var labels = Array.from(document.querySelectorAll('[data-canvas-label]')).slice(0, 1000).map(function (element) {
      var group = element.closest('[data-canvas-group]')
      var label = { name: element.getAttribute('data-canvas-label'), rect: rect(element) }
      if (group) label.group = group.getAttribute('data-canvas-group')
      if (element.hasAttribute('data-canvas-id')) label.id = element.getAttribute('data-canvas-id')
      return label
    }).filter(function (label) {
      return [label.name, label.group, label.id].every(function (s) { return s === undefined || typeof s === 'string' && s.length <= 200 }) && validRect(label)
    })
    // Controls that work: click-through links, plus author-marked hotspots with an optional tooltip.
    var hotspots = Array.from(document.querySelectorAll('[data-canvas-goto], [data-canvas-hotspot]')).slice(0, 500).map(function (element) {
      var go = element.getAttribute('data-canvas-goto')
      // The bridge swallows goto clicks, so a malformed target leaves the control dead.
      if (go !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(go)) return null
      var visible = visibleRect(element)
      if (!visible) return null
      var spot = { rect: visible }
      var tip = element.getAttribute('data-canvas-hotspot')
      if (tip) spot.tip = tip.slice(0, 500)
      if (go) spot.goto = go
      return spot
    }).filter(function (spot) { return spot && validRect(spot) })
    if (new TextEncoder().encode(JSON.stringify(labels)).byteLength <= 1000000) post('labels', { labels: labels, hotspots: hotspots })
  }
  var timer
  var lastPendingSnapshot
  var live = false
  window.addEventListener('click', function (event) {
    if (!live) return
    var go = event.target instanceof Element && event.target.closest('[data-canvas-goto]')
    if (!go) return
    event.preventDefault()
    event.stopImmediatePropagation()
    post('goto', { target: go.getAttribute('data-canvas-goto') })
  }, true)
  window.addEventListener('keydown', function (event) {
    if (live && event.key === 'Escape') { event.preventDefault(); post('escape', {}) }
  }, true)
  window.addEventListener('wheel', function (event) {
    if (!live || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    post('zoom', { deltaY: event.deltaY, deltaMode: event.deltaMode, x: event.clientX, y: event.clientY })
  }, { passive: false, capture: true })
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(report, 100)
  }
  window.addEventListener('message', function (event) {
    var data = event.data
    if (event.source !== window.parent || !data || data.source !== 'commando-canvas' || typeof data.type !== 'string') return
    if (data.type === 'interaction') { live = data.live === true; return }
    if (data.type === 'redline-pending') {
      // SDK hydration mutates DOM and triggers a label report. Do not echo that back forever.
      var serialized = JSON.stringify(data.snapshot)
      if (serialized === lastPendingSnapshot) return
      lastPendingSnapshot = serialized
      window.__commandoRedlinePendingSnapshot = data.snapshot
      window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: data.snapshot }))
      return
    }
    if (data.type !== 'hit-test') return
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || typeof data.requestId !== 'string' && typeof data.requestId !== 'number') return
    // Hit-test coordinates are iframe viewport CSS pixels; reply rectangles are document CSS pixels.
    var element = document.elementFromPoint(data.x, data.y)
    if (!element) { post('hit', { requestId: data.requestId, selector: null, rect: null }); return }
    var label = element.closest('[data-canvas-label]')
    var payload = { requestId: data.requestId, selector: selector(element), rect: rect(element, true), tag: element.localName, text: (element.textContent || '').trim().slice(0, 500) }
    if (label) {
      payload.label = label.getAttribute('data-canvas-label')
      if (label.hasAttribute('data-canvas-id')) payload.labelId = label.getAttribute('data-canvas-id')
    }
    post('hit', payload)
  })
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  document.addEventListener('DOMContentLoaded', report)
  window.addEventListener('load', report)
  window.addEventListener('resize', schedule)
  // Hotspot dots are always drawn, so re-report once sliding or fading content settles.
  window.addEventListener('transitionend', schedule, true)
  window.addEventListener('animationend', schedule, true)
  // Scroll does not bubble; capture observes nested scroll containers too.
  window.addEventListener('scroll', schedule, true)
  if (document.readyState !== 'loading') report()
})()
