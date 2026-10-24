import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest, WebViewErrorEvent, WebViewHttpErrorEvent, WebViewNavigation } from 'react-native-webview/lib/WebViewTypes'

import { useTheme } from '../../theme'
import {
  encodeNativeTileCommand,
  NATIVE_TILE_PAGE_SCRIPT,
  parseNativeTileMessage,
  type NativeTileCommand,
  type NativeTileEvent,
} from './bridge'
import { isExpectedOrigin } from './target'

export type NativeWebTileHandle = {
  send: (command: NativeTileCommand) => void
  reload: () => void
}

/**
 * A tile page in a real WKWebView on the phone: native scrolling, text
 * selection, pinch zoom and crisp text, and none of the screencast's PNG
 * traffic. The bridge script runs before the page's own on every document;
 * messages are only accepted while the WebView is on the origin the tile was
 * opened for, so a page that navigates elsewhere cannot queue answers.
 */
export const NativeWebTile = forwardRef<NativeWebTileHandle, {
  url: string
  expectedOrigin: string
  onEvent: (event: NativeTileEvent) => void
  onNavigate?: (url: string) => void
  /** The document itself failed (network error or an HTTP error status). */
  onLoadFailed: (detail: string) => void
}>(function NativeWebTile({ url, expectedOrigin, onEvent, onNavigate, onLoadFailed }, ref) {
  const theme = useTheme()
  const webView = useRef<WebView>(null)
  const [loading, setLoading] = useState(true)
  const currentUrl = useRef(url)
  // Only the tile's own first document decides whether the phone can show it;
  // a broken link followed later is the page's business.
  const settled = useRef(false)
  const failed = useRef(false)

  useImperativeHandle(ref, () => ({
    send: (command) => webView.current?.injectJavaScript(encodeNativeTileCommand(command)),
    reload: () => webView.current?.reload(),
  }), [])

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const reported = event.nativeEvent.url
    if (!isExpectedOrigin(expectedOrigin, reported)) return
    const parsed = parseNativeTileMessage(event.nativeEvent.data, reported)
    if (parsed) onEvent(parsed)
  }, [expectedOrigin, onEvent])

  const handleNavigation = useCallback((navigation: WebViewNavigation) => {
    currentUrl.current = navigation.url
    onNavigate?.(navigation.url)
  }, [onNavigate])

  const handleHttpError = useCallback((event: WebViewHttpErrorEvent) => {
    const { statusCode, url: failedUrl } = event.nativeEvent
    // Only the document itself counts; a missing image is the page's business.
    if (settled.current || (failedUrl !== currentUrl.current && failedUrl !== url)) return
    failed.current = true
    onLoadFailed(`The page answered HTTP ${statusCode}.`)
  }, [onLoadFailed, url])

  const handleError = useCallback((event: WebViewErrorEvent) => {
    if (settled.current) return
    failed.current = true
    onLoadFailed(event.nativeEvent.description || 'The page could not be loaded.')
  }, [onLoadFailed])

  const shouldStart = useCallback((request: ShouldStartLoadRequest) => (
    /^https?:/i.test(request.url) || request.url === 'about:blank'
  ), [])

  return (
    <View style={[styles.root, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <WebView
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        injectedJavaScriptBeforeContentLoaded={NATIVE_TILE_PAGE_SCRIPT}
        injectedJavaScriptForMainFrameOnly
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onError={handleError}
        onHttpError={handleHttpError}
        onLoadEnd={() => {
          setLoading(false)
          if (!failed.current) settled.current = true
        }}
        onLoadStart={() => setLoading(true)}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigation}
        onShouldStartLoadWithRequest={shouldStart}
        originWhitelist={['http://*', 'https://*', 'about:*']}
        pullToRefreshEnabled
        ref={webView}
        setSupportMultipleWindows={false}
        source={{ uri: url }}
        style={styles.webView}
        webviewDebuggingEnabled={__DEV__}
      />
      {loading ? (
        <View pointerEvents="none" style={styles.spinner}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  webView: { flex: 1, backgroundColor: 'transparent' },
  spinner: { position: 'absolute', top: 12, right: 12 },
})
