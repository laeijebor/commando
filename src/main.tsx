import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { DetachedWebPaneApp } from './DetachedWebPaneApp'
import { detachedWebPaneIdFromLocation } from './nativeWindowBridge'
import { applyTheme, storedTheme } from './theme'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import './styles.css'

applyTheme(storedTheme())

const root = createRoot(document.getElementById('root')!)
const detachedWebPaneId = detachedWebPaneIdFromLocation()
const render = () => {
  root.render(
    <StrictMode>
      {detachedWebPaneId
        ? <DetachedWebPaneApp webPaneId={detachedWebPaneId} />
        : <App />}
    </StrictMode>,
  )
}

void Promise.all([
  document.fonts.load('400 10px "JetBrains Mono"'),
  document.fonts.load('700 10px "JetBrains Mono"'),
]).then(render, render)
