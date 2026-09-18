import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

import {
  encodeCommand,
  parseTerminalEvent,
  TerminalCommandQueue,
  type TerminalCommand,
  type TerminalEvent,
} from './bridge'
import { TERMINAL_HTML } from './terminal-html'

export type TerminalSurfaceHandle = {
  /** Queued while the page is still loading, injected once it is ready. */
  send: (command: TerminalCommand) => void
  measure: () => void
  scrollToBottom: () => void
}

export type TerminalSurfaceProps = {
  onEvent: (event: TerminalEvent) => void
  /** True once the page has drained a queue it had to drop bytes from. */
  onNeedsReseed?: () => void
  style?: StyleProp<ViewStyle>
}

/**
 * The xterm page, in a WebView. The page renders and measures; every decision
 * — what to write, how big the pane should be, what the keyboard does — is
 * made on this side and sent down as a `TerminalCommand`.
 */
export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(
  function TerminalSurface({ onEvent, onNeedsReseed, style }, ref) {
    const webViewRef = useRef<WebView>(null)
    const queueRef = useRef(new TerminalCommandQueue())

    const inject = useCallback((commands: readonly TerminalCommand[]) => {
      const webView = webViewRef.current
      if (!webView) return
      for (const command of commands) webView.injectJavaScript(encodeCommand(command))
    }, [])

    const send = useCallback((command: TerminalCommand) => {
      inject(queueRef.current.push(command))
    }, [inject])

    useImperativeHandle(ref, () => ({
      send,
      measure: () => send({ type: 'measure' }),
      scrollToBottom: () => send({ type: 'scroll_to_bottom' }),
    }), [send])

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      const parsed = parseTerminalEvent(event.nativeEvent.data)
      if (!parsed) return
      if (parsed.type === 'ready') {
        const queue = queueRef.current
        const drained = queue.markReady()
        inject(drained)
        if (queue.needsReseed) {
          queue.clearReseed()
          onNeedsReseed?.()
        }
      }
      onEvent(parsed)
    }, [inject, onEvent, onNeedsReseed])

    const handleLoadStart = useCallback(() => {
      queueRef.current.markLoading()
    }, [])

    return (
      <View style={[styles.surface, style]}>
        <WebView
          allowsLinkPreview={false}
          automaticallyAdjustContentInsets={false}
          bounces={false}
          // The page is one document with everything inlined; nothing it holds
          // should be able to navigate anywhere.
          incognito
          javaScriptEnabled
          onLoadStart={handleLoadStart}
          onMessage={handleMessage}
          originWhitelist={['about:blank']}
          ref={webViewRef}
          // A source-sized pane is wider than the phone on purpose: the page
          // pans sideways rather than reflowing the agent's output.
          scrollEnabled
          setSupportMultipleWindows={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          source={{ html: TERMINAL_HTML }}
          style={styles.webView}
          webviewDebuggingEnabled={__DEV__}
        />
      </View>
    )
  },
)

const styles = StyleSheet.create({
  surface: { flex: 1, overflow: 'hidden', borderRadius: 14, borderWidth: 1 },
  webView: { flex: 1, backgroundColor: '#232136' },
})
