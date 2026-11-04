// Tiny deck runtime: one slide at a time, scaled to fit; #N picks the slide,
// ?theme=paper swaps the theme. Keys: ←/→, Home/End. Print shows every slide.
(() => {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme')
  if (theme && /^[a-z-]+$/.test(theme)) document.getElementById('theme').href = `${base()}themes/${theme}.css`
  const slides = [...document.querySelectorAll('.slide')]
  const title = document.querySelector('meta[name="deck:title"]')?.content || document.title
  slides.forEach((slide, i) => {
    const n = Number(slide.dataset.n || i + 1)
    slide.dataset.foot = title
    const pn = document.createElement('div'); pn.className = 'pn'; pn.textContent = `${n} / ${slide.dataset.total || slides.length}`
    const mark = document.createElement('div'); mark.className = 'mark'
    slide.append(pn, mark)
  })
  let current = 0
  const show = (i) => {
    current = Math.max(0, Math.min(slides.length - 1, i))
    slides.forEach((s, j) => s.classList.toggle('on', j === current))
    parent !== window && parent.postMessage({ deck: 'slide', index: current, count: slides.length }, '*')
  }
  const fromHash = () => show((parseInt(location.hash.slice(1), 10) || 1) - 1)
  const fit = () => {
    const k = Math.min(innerWidth / 1280, innerHeight / 720)
    slides.forEach((s) => { s.style.transform = `scale(${k})` })
  }
  addEventListener('hashchange', fromHash)
  addEventListener('resize', fit)
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') show(current + 1)
    if (e.key === 'ArrowLeft') show(current - 1)
    if (e.key === 'Home') show(0)
    if (e.key === 'End') show(slides.length - 1)
  })
  addEventListener('message', (e) => { if (e.data?.deck === 'go') show(e.data.index) })
  function base() { const s = document.currentScript?.src || document.querySelector('script[src$="deck.js"]').src; return s.replace(/deck\.js.*$/, '') }
  fit(); fromHash()
})()
