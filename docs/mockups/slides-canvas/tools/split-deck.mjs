// Splits deck/deck.html into one HTML file per slide so each can be a canvas frame.
// Usage: node tools/split-deck.mjs   (run from the canvas folder)
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('deck/deck.html', 'utf8')
const sections = src.match(/<!-- \d+ ·[\s\S]*?<\/section>/g)
const [head] = src.split('<main class="deck">')
const tail = '</main>\n<script src="deck/deck.js"></script>\n</body>\n</html>\n'
const rebase = (html) => html.replace(/(href|src)="(?!https?:|#|\/)([^"]+)"/g, '$1="deck/$2"')

const variants = [
  { theme: 'ink', prefix: 's', slides: [1, 2, 3, 4, 5, 6, 7, 8] },
  { theme: 'paper', prefix: 'paper-', slides: [1, 4, 7] },
  { theme: 'brand-harbor', prefix: 'harbor-', slides: [1, 4, 7] },
]
for (const { theme, prefix, slides } of variants) {
  for (const n of slides) {
    const section = sections[n - 1].replace('<section class="slide"', `<section class="slide" data-n="${n}" data-total="${sections.length}"`)
    const html = rebase(head).replace('themes/ink.css', `themes/${theme}.css`) + '<main class="deck">\n' + rebase(section) + '\n' + tail
    writeFileSync(`${prefix}${n}.html`, html)
  }
}
console.log(`wrote ${variants.reduce((a, v) => a + v.slides.length, 0)} slide frames from ${sections.length} slides`)
