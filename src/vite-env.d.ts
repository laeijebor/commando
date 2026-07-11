/// <reference types="vite/client" />

interface Window {
  __commandoQaTerminals?: Map<string, import('@xterm/xterm').Terminal>
}
