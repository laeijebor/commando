/*
 * The pane page's own logic. `scripts/build-terminal-html.mjs` inlines the
 * xterm.js bundle above this file and the result is handed to the WebView as a
 * self-contained document, so nothing here is ever fetched over the network.
 *
 * The split of responsibilities is deliberate: React Native owns the socket,
 * the keyboard and every decision about size, and this page only renders the
 * bytes it is given and reports what it measures. Anything worth unit-testing
 * therefore lives in `src/terminal/bridge.ts`, not here.
 */
/* global Terminal */
;(function () {
  'use strict'

  /** TERMINAL_SCROLLBACK_LINES in shared/protocol.ts. */
  var SCROLLBACK = 5000
  /*
   * JetBrains Mono cannot be loaded inside the WebView without bundling the
   * font, so the pane falls back to the system monospace stack. Everything
   * else matches the desktop's `new Terminal(...)` in src/XtermPane.tsx.
   */
  var FONT_FAMILY = 'Menlo, ui-monospace, "SF Mono", SFMono-Regular, Consolas, monospace'
  /* Rosé Pine Moon, copied from TERMINAL_THEME in src/XtermPane.tsx. */
  var THEME = {
    background: '#232136',
    foreground: '#e0def4',
    cursor: '#e0def4',
    cursorAccent: '#232136',
    selectionBackground: '#44415a',
    selectionForeground: '#e0def4',
    selectionInactiveBackground: '#393552',
    black: '#393552',
    red: '#eb6f92',
    green: '#3e8fb0',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ea9a97',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#3e8fb0',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ea9a97',
    brightWhite: '#e0def4',
  }

  function post(event) {
    var bridge = window.ReactNativeWebView
    if (!bridge) return
    try {
      bridge.postMessage(JSON.stringify(event))
    } catch (error) {
      // A postMessage that cannot be serialised is not worth taking the page
      // down for; the next event will get through.
    }
  }

  function decodeBase64(data) {
    var binary = window.atob(data)
    var bytes = new Uint8Array(binary.length)
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  var host = document.getElementById('terminal')

  var terminal = new Terminal({
    allowProposedApi: true,
    altClickMovesCursor: false,
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    disableStdin: true,
    drawBoldTextInBrightColors: true,
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    lineHeight: 1,
    macOptionClickForcesSelection: true,
    minimumContrastRatio: 1,
    scrollback: SCROLLBACK,
    scrollOnUserInput: true,
    theme: THEME,
  })
  terminal.open(host)

  function screenElement() {
    return host.querySelector('.xterm-screen')
  }

  function atBottom() {
    var buffer = terminal.buffer.active
    return buffer.viewportY >= buffer.baseY
  }

  function postCells() {
    var screen = screenElement()
    if (!screen || terminal.cols < 1 || terminal.rows < 1) return
    var bounds = screen.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    post({
      type: 'cells',
      cellWidth: bounds.width / terminal.cols,
      cellHeight: bounds.height / terminal.rows,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      cols: terminal.cols,
      rows: terminal.rows,
    })
  }

  function postScroll() {
    post({ type: 'scroll', atBottom: atBottom() })
  }

  terminal.onSelectionChange(function () {
    var selection = terminal.getSelection()
    if (!selection) return
    post({ type: 'selection', text: selection })
  })
  terminal.onScroll(postScroll)
  window.addEventListener('resize', function () {
    postCells()
  })

  function applyReset(command) {
    terminal.options.cursorBlink = command.cursorBlink
    terminal.options.cursorStyle = command.cursorShape === 'default' ? 'block' : command.cursorShape
    terminal.resize(command.cols, command.rows)
    terminal.reset()
    terminal.write(decodeBase64(command.data), function () {
      post({ type: 'seeded', revision: command.revision })
      postCells()
      postScroll()
    })
  }

  function receive(command) {
    switch (command.type) {
      case 'reset':
        applyReset(command)
        return
      case 'write':
        terminal.write(decodeBase64(command.data))
        return
      case 'resize':
        terminal.resize(command.cols, command.rows)
        postCells()
        return
      case 'options':
        if (typeof command.fontSize === 'number') terminal.options.fontSize = command.fontSize
        postCells()
        return
      case 'measure':
        postCells()
        return
      case 'scroll_to_bottom':
        terminal.scrollToBottom()
        postScroll()
        return
      case 'clear_selection':
        terminal.clearSelection()
        return
      default:
        return
    }
  }

  window.__commandoTerminal = {
    receive: function (command) {
      try {
        receive(command)
      } catch (error) {
        post({ type: 'error', message: String((error && error.message) || error) })
      }
    },
  }

  postCells()
  post({ type: 'ready' })
})()
