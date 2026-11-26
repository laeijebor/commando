// Injected into an artifact page a chat reply shows inline (src/chat/EmbedFrame.tsx,
// `?chat-embed=1`). The page runs in a sandboxed frame, so keys typed inside it never
// reach Commando: this relays Esc in the canvas frame message shape, so a maximised
// mock-up restores. A page that handles Esc itself (preventDefault) keeps it.
(function () {
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    window.parent.postMessage({ source: 'commando-canvas-frame', frameId: 'chat-embed', type: 'escape' }, '*')
  })
})()
