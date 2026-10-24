import {
  MAX_QUESTION_SNAPSHOT_BYTES,
  MAX_RESPONSE_PAYLOAD_BYTES,
  parseRedlinePageQuestionSnapshot,
  parseRedlinePageResponse,
  redlinePageKey,
  type RedlinePagePendingSnapshot,
  type RedlinePageQuestionSnapshot,
  type RedlinePageResponse,
} from '@commando/redline-response'

import type { WebPanePendingNote } from '@commando/protocol'

import { parseTileInspectResult, type TileInspectSuccess } from '../protocol'

/**
 * The phone's side of the native tile bridge — the react-native-webview twin
 * of the desktop shell's `WebViewTileBridge.swift` and `src/nativeWebViewBridge.ts`.
 *
 * The page talks to Commando through `window.__commandoRedlineQueue(payload)`,
 * the binding the redline SDK and canvas frames already call in a chromium
 * tile (CDP binding) or the desktop WebView (script message handler). Here it
 * posts to React Native. Pending state goes the other way exactly as the
 * desktop does it: `window.__commandoRedlinePendingSnapshot` plus a
 * `commando:redline-pending` event.
 *
 * Review mode adds what the daemon's `inspect` / `resolve_selectors` give the
 * screencast: a tap names an element instead of activating it, and queued
 * notes are pinned onto the page — drawn by the page itself, so they scroll
 * and zoom with it.
 */

export const NATIVE_TILE_MESSAGE_SOURCE = 'commando-native-tile'

const MAX_PAYLOAD_BYTES = Math.max(MAX_QUESTION_SNAPSHOT_BYTES, MAX_RESPONSE_PAYLOAD_BYTES)
// The payload travels JSON-escaped inside the envelope, so every quote costs
// two bytes; the exact limit is checked on the payload once it is out.
const MAX_MESSAGE_BYTES = MAX_PAYLOAD_BYTES * 2 + 4_096
const MAX_URL_LENGTH = 2_048

/**
 * Runs before the page's own scripts on every main-frame document. Plain ES5-ish
 * source on purpose: it is injected as text, and must not depend on the page.
 * The constants mirror `shared/redline-response.ts` and the inspect limits in
 * `shared/tile-inspect.ts`.
 */
export const NATIVE_TILE_PAGE_SCRIPT = `(function () {
  'use strict';
  if (window.__commandoMobileTile) return;
  var SOURCE = ${JSON.stringify(NATIVE_TILE_MESSAGE_SOURCE)};
  var MAX_PAYLOAD = ${MAX_PAYLOAD_BYTES};
  var post = function (message) {
    message.source = SOURCE;
    message.url = String(location.href).slice(0, ${MAX_URL_LENGTH});
    try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (error) {}
  };
  Object.defineProperty(window, '__commandoRedlineQueue', {
    configurable: true,
    value: function (payload) {
      if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return;
      post({ type: 'redline', payload: payload });
    }
  });

  var escapeCss = function (value) {
    return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; });
  };
  /* id -> data-testid -> nth-of-type path, as the desktop and Chromium inspectors build it. */
  var cssPath = function (target) {
    var parts = [];
    var element = target;
    while (element && element.nodeType === 1 && element.tagName.toLowerCase() !== 'html') {
      if (element.id) { parts.unshift('#' + escapeCss(element.id)); break; }
      var testId = element.getAttribute('data-testid');
      if (testId) { parts.unshift(element.tagName.toLowerCase() + '[data-testid="' + escapeCss(testId) + '"]'); break; }
      var tag = element.tagName.toLowerCase();
      var parent = element.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === element.tagName; });
      parts.unshift(same.length === 1 ? tag : tag + ':nth-of-type(' + (same.indexOf(element) + 1) + ')');
      element = parent;
    }
    return parts.join(' > ').slice(0, 1024);
  };

  var review = false;
  var pins = [];
  var focusSelector = null;
  var layer = null;
  var ensureLayer = function () {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.setAttribute('data-commando-pins', '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  };
  var find = function (selector) {
    if (!selector || selector.indexOf('redline:') === 0) return null;
    try { return document.querySelector(selector); } catch (error) { return null; }
  };
  var box = function (element) {
    var rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
  };
  var drawn = false;
  var draw = function () {
    drawn = false;
    if (!document.body) return;
    var root = ensureLayer();
    root.textContent = '';
    if (!review) return;
    var focus = find(focusSelector);
    var focusBox = focus && box(focus);
    if (focusBox) {
      var outline = document.createElement('div');
      outline.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid #f6c177;background:rgba(246,193,119,.14);border-radius:4px;' +
        'left:' + focusBox.x + 'px;top:' + focusBox.y + 'px;width:' + focusBox.width + 'px;height:' + focusBox.height + 'px;';
      root.appendChild(outline);
    }
    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var element = find(pin.selector);
      var at = element && box(element);
      if (!at) continue;
      var color = pin.kind === 'response' ? '#9ccfd8' : '#c4a7e7';
      var frame = document.createElement('div');
      frame.style.cssText = 'position:absolute;box-sizing:border-box;border:1.5px ' + (pin.selected ? 'solid' : 'dashed') + ' ' + color + ';border-radius:4px;' +
        'left:' + at.x + 'px;top:' + at.y + 'px;width:' + at.width + 'px;height:' + at.height + 'px;';
      root.appendChild(frame);
      var badge = document.createElement('button');
      badge.type = 'button';
      badge.setAttribute('data-commando-pin', String(pin.noteId));
      badge.setAttribute('aria-label', 'Queued note ' + pin.label);
      badge.textContent = pin.label;
      badge.style.cssText = 'position:absolute;pointer-events:auto;min-width:24px;height:24px;padding:0 6px;border-radius:12px;border:0;' +
        'font:600 12px -apple-system,system-ui,sans-serif;color:#191724;background:' + color + ';box-shadow:0 2px 6px rgba(0,0,0,.35);' +
        'left:' + Math.max(0, at.x - 10) + 'px;top:' + Math.max(0, at.y - 10) + 'px;';
      root.appendChild(badge);
    }
  };
  var schedule = function () {
    if (drawn) return;
    drawn = true;
    (window.requestAnimationFrame || setTimeout)(draw);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);

  /* In review a tap names an element; nothing on the page activates. */
  var onPin = function (event) {
    var target = event.target;
    return Boolean(target && target.closest && target.closest('[data-commando-pin]'));
  };
  var stop = function (event) {
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  };
  /* Presses still reach the browser, so it synthesises the click; the page's own handlers do not see them. */
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (review && !onPin(event)) stop(event);
    }, true);
  });
  ['submit', 'auxclick', 'dblclick', 'contextmenu'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!review || onPin(event)) return;
      event.preventDefault();
      stop(event);
    }, true);
  });
  document.addEventListener('click', function (event) {
    if (!review) return;
    var target = event.target;
    var pin = target && target.closest && target.closest('[data-commando-pin]');
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (pin) {
      post({ type: 'pin', noteId: Number(pin.getAttribute('data-commando-pin')) });
      return;
    }
    if (!target || target.nodeType !== 1) return;
    var rect = target.getBoundingClientRect();
    var text = (target.textContent || '').trim();
    var result = {
      ok: true,
      selector: cssPath(target),
      tag: target.tagName.toLowerCase().slice(0, 32),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      snippet: String(target.outerHTML || '').slice(0, 2048)
    };
    if (text) result.text = text.slice(0, 512);
    post({ type: 'inspect', result: result });
  }, true);

  window.__commandoMobileTile = {
    setReview: function (enabled) {
      review = enabled === true;
      if (!review) focusSelector = null;
      schedule();
    },
    setPins: function (next) {
      pins = Array.isArray(next) ? next.slice(0, 50) : [];
      schedule();
    },
    setFocus: function (selector) {
      focusSelector = typeof selector === 'string' ? selector : null;
      schedule();
    },
    applyPending: function (snapshot) {
      window.__commandoRedlinePendingSnapshot = snapshot;
      window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: snapshot }));
    },
    reveal: function (selector) {
      if (window.redline && typeof window.redline.revealSelector === 'function') {
        try { if (window.redline.revealSelector(selector)) return; } catch (error) {}
      }
      var element = find(selector);
      if (!element) return;
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  };
  var announce = function () {
    post({ type: 'ready' });
    schedule();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
})();
true;`

export type NativeTilePin = {
  noteId: number
  selector: string
  /** What the badge reads: the note's position in the queue. */
  label: string
  kind: 'annotation' | 'response'
  selected?: boolean
}

export type NativeTileCommand =
  | { type: 'setReview'; enabled: boolean }
  | { type: 'setPins'; pins: readonly NativeTilePin[] }
  | { type: 'setFocus'; selector: string | null }
  | { type: 'applyPending'; snapshot: RedlinePagePendingSnapshot }
  | { type: 'reveal'; selector: string }

/**
 * One command as a self-contained script for `injectJavaScript`. The argument
 * is JSON — never interpolated page text — and the call is a no-op before the
 * page script has run.
 */
export function encodeNativeTileCommand(command: NativeTileCommand): string {
  const argument = (() => {
    switch (command.type) {
      case 'setReview': return command.enabled
      case 'setPins': return command.pins
      case 'setFocus': return command.selector
      case 'applyPending': return command.snapshot
      case 'reveal': return command.selector
    }
  })()
  // JSON is a valid JS expression (U+2028/2029 included, since ES2019).
  const json = JSON.stringify(argument ?? null)
  return `(function(){var t=window.__commandoMobileTile;if(t&&typeof t.${command.type}==='function')t.${command.type}(${json});})();true;`
}

export type NativeTileEvent =
  | { type: 'ready'; url: string }
  | { type: 'response'; url: string; response: RedlinePageResponse }
  | { type: 'questions'; url: string; snapshot: RedlinePageQuestionSnapshot }
  | { type: 'inspect'; url: string; result: TileInspectSuccess }
  | { type: 'pin'; url: string; noteId: number }

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Validates one `onMessage` body. Everything in it is page-controlled, so it
 * goes through the same shared parsers the daemon and the desktop use.
 * `reportedUrl` is the WebView's own idea of the page (`nativeEvent.url`) —
 * trusted over the URL the page claims.
 */
export function parseNativeTileMessage(data: unknown, reportedUrl: string): NativeTileEvent | null {
  if (typeof data !== 'string' || utf8Bytes(data) > MAX_MESSAGE_BYTES) return null
  const url = boundedHttpUrl(reportedUrl)
  if (!url) return null
  let message: unknown
  try {
    message = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const record = message as Record<string, unknown>
  if (record.source !== NATIVE_TILE_MESSAGE_SOURCE) return null

  switch (record.type) {
    case 'ready':
      return { type: 'ready', url }
    case 'redline': {
      const payload = record.payload
      if (typeof payload !== 'string') return null
      const bytes = utf8Bytes(payload)
      if (bytes > MAX_PAYLOAD_BYTES) return null
      let value: unknown
      try {
        value = JSON.parse(payload)
      } catch {
        return null
      }
      const questions = parseRedlinePageQuestionSnapshot(value)
      if (questions) return bytes <= MAX_QUESTION_SNAPSHOT_BYTES ? { type: 'questions', url, snapshot: questions } : null
      if (bytes > MAX_RESPONSE_PAYLOAD_BYTES) return null
      const response = parseRedlinePageResponse(value)
      return response ? { type: 'response', url, response } : null
    }
    case 'inspect': {
      const result = record.result
      if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
      const parsed = parseTileInspectResult(result as Record<string, unknown>)
      if (!parsed.ok || parsed.selector.length > 1_024 || parsed.tag.length > 32) return null
      return {
        type: 'inspect',
        url,
        result: {
          ...parsed,
          ...(parsed.text !== undefined ? { text: parsed.text.slice(0, 512) } : {}),
          ...(parsed.snippet !== undefined ? { snippet: parsed.snippet.slice(0, 2_048) } : {}),
        },
      }
    }
    case 'pin': {
      const noteId = record.noteId
      return typeof noteId === 'number' && Number.isSafeInteger(noteId) && noteId > 0
        ? { type: 'pin', url, noteId }
        : null
    }
    default:
      return null
  }
}

/**
 * Queued notes to pin on the page on screen: only those queued for this page
 * (origin + path, as the daemon keys pages) whose selector the page can look
 * up. In-page answers carry `redline:` pseudo selectors and are not pinned.
 */
export function pinsForPage(
  notes: readonly WebPanePendingNote[],
  pageUrl: string,
  selectedNoteId: number | null,
): NativeTilePin[] {
  const page = redlinePageKey(pageUrl)
  const pins: NativeTilePin[] = []
  notes.forEach((note, index) => {
    if (pins.length >= 50) return
    if (note.pageUrl !== undefined && redlinePageKey(note.pageUrl) !== page) return
    if (!note.selector || note.selector.startsWith('redline:')) return
    pins.push({
      noteId: note.id,
      selector: note.selector,
      label: String(index + 1),
      kind: note.response ? 'response' : 'annotation',
      ...(note.id === selectedNoteId ? { selected: true } : {}),
    })
  })
  return pins
}
