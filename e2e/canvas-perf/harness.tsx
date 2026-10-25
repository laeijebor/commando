/** Canvas zoom/pan benchmark harness: the real CanvasPane against a static
 * artifact folder served by vite.config.ts. No daemon, tmux or user state. */
import { createRoot } from 'react-dom/client'
import { CanvasPane } from '../../src/CanvasPane'
import { applyTheme } from '../../src/theme'
import '../../src/styles.css'

applyTheme('purple')
const params = new URLSearchParams(location.search)
const width = params.get('width')
if (width) document.documentElement.style.setProperty('--harness-width', `${width}px`)
createRoot(document.getElementById('root')!).render(
  <article className="web-pane">
    <CanvasPane artifactId="00000000000000aa" manifest="canvas.json" />
  </article>,
)
