/* Canvas iframe bridge. The sandbox has an opaque origin: authenticate the parent by window identity. */
;(function () {
  'use strict'
  var script = document.currentScript
  var frameId = script && script.getAttribute('data-canvas-frame')
  if (!frameId || !/^[A-Za-z0-9_-]{1,64}$/.test(frameId)) return

  function post(type, payload) {
    window.parent.postMessage(Object.assign({ source: 'commando-canvas-frame', frameId: frameId, type: type }, payload), '*')
  }
  function rect(element) {
    var r = element.getBoundingClientRect()
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
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
  function report() {
    post('labels', { labels: Array.from(document.querySelectorAll('[data-canvas-label]')).map(function (element) {
      var group = element.closest('[data-canvas-group]')
      var label = { name: element.getAttribute('data-canvas-label'), rect: rect(element) }
      if (group) label.group = group.getAttribute('data-canvas-group')
      if (element.hasAttribute('data-canvas-id')) label.id = element.getAttribute('data-canvas-id')
      return label
    }) })
  }
  var timer
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(report, 100)
  }
  window.addEventListener('message', function (event) {
    var data = event.data
    if (event.source !== window.parent || !data || data.source !== 'commando-canvas' || data.type !== 'hit-test') return
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || typeof data.requestId !== 'string' && typeof data.requestId !== 'number') return
    // Hit-test coordinates are iframe viewport CSS pixels; reply rectangles are document CSS pixels.
    var element = document.elementFromPoint(data.x, data.y)
    if (!element) { post('hit', { requestId: data.requestId, selector: null, rect: null }); return }
    var label = element.closest('[data-canvas-label]')
    var payload = { requestId: data.requestId, selector: selector(element), rect: rect(element) }
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
  if (document.readyState !== 'loading') report()
})()
