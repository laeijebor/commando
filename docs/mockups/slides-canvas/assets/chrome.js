// Shared tab strip + toolbar for the static tile mockups. <div data-chrome="grid|slides|page"></div>
document.querySelectorAll('[data-chrome]').forEach((el) => {
  const view = el.dataset.chrome
  const seg = ['Slides', 'Grid', 'One-pager'].map((v) => `<button class="${v.toLowerCase() === view ? 'on' : ''}">${v}</button>`).join('')
  el.outerHTML = `
  <div class="tabs"><div class="tab"><span class="ic">◎</span>localhost:5273</div>
    <div class="tab on"><span class="ic">▭</span>Reconnect loop fix<span class="x">×</span></div>
    <div class="tab"><span class="ic">▦</span>Canvas · Settings</div><span class="plus">+</span></div>
  <div class="bar" data-canvas-group="Toolbar">
    <span class="title">Reconnect loop fix</span><span class="sub">${el.dataset.counter || '8 slides'}</span>
    <span class="chip e">round 2 · 1 slide changed</span><span class="spacer"></span>
    <div class="seg">${seg}</div>
    <button class="btn ${el.dataset.open === 'theme' ? 'active' : ''}" data-canvas-label="Theme picker"><span class="swatch" style="background:${el.dataset.swatch || '#b9a3ff'}"></span>${el.dataset.theme || 'Ink'} ▾</button>
    <button class="btn">Notes</button><button class="btn icon">💬</button><button class="btn">▶ Present</button>
    <button class="btn primary ${el.dataset.open === 'export' ? 'active' : ''}" data-canvas-label="Export menu button">Export ▾</button>
  </div>`
})
// <div class="strip" data-strip="4" data-deck-theme="brand-harbor"></div> → filmstrip with slide 4 selected
document.querySelectorAll('[data-strip]').forEach((el) => {
  const on = +el.dataset.strip, theme = el.dataset.deckTheme
  const src = (n) => (theme ? `deck/deck.html?theme=${theme}#${n}` : `s${n}.html`)
  el.innerHTML = Array.from({ length: 8 }, (_, i) => i + 1).map((n) =>
    `<div class="thumb ${n === on ? 'on' : ''}"><iframe src="${src(n)}" tabindex="-1"></iframe><span class="n">${n}</span></div>`).join('')
})
