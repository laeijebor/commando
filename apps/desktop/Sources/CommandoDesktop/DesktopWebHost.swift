import AppKit
import WebKit

@MainActor
protocol JavaScriptConfirmationPresenting {
    func present(
        message: String,
        in window: NSWindow?
    ) async -> Bool
}

@MainActor
struct AppKitJavaScriptConfirmationPresenter: JavaScriptConfirmationPresenting {
    func present(
        message: String,
        in window: NSWindow?
    ) async -> Bool {
        guard let window else { return false }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { response in
                continuation.resume(returning: response == .alertFirstButtonReturn)
            }
        }
    }
}

@MainActor
protocol JavaScriptTextInputPresenting {
    func present(
        message: String,
        defaultText: String?,
        in window: NSWindow?
    ) async -> String?
}

@MainActor
struct AppKitJavaScriptTextInputPresenter: JavaScriptTextInputPresenting {
    func present(
        message: String,
        defaultText: String?,
        in window: NSWindow?
    ) async -> String? {
        guard let window else { return nil }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 240, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { response in
                continuation.resume(
                    returning: response == .alertFirstButtonReturn ? field.stringValue : nil
                )
            }
        }
    }
}

@MainActor
final class DesktopWebHost: NSObject, WKNavigationDelegate {
    let rootView: NSView
    let webView: WKWebView
    let overlay: TerminalOverlayView
    let connectionStatusView: ConnectionStatusView
    private(set) var zoomPercent = ZoomPreference.defaultPercent

    var zoomScale: CGFloat { CGFloat(zoomPercent) / 100 }

    private let configuration: DesktopConfiguration
    private let role: DesktopWindowRole
    private let admission: WebContentAdmission
    private let bridge: NativeTerminalBridge
    private let webViewTiles: WebViewTileBridge
    private let confirmationPresenter: any JavaScriptConfirmationPresenting
    private let textInputPresenter: any JavaScriptTextInputPresenting
    private let externalURLHandler: any ExternalURLHandling
    private let windowBridge: NativeWindowBridge
    private var scriptMessageHandler: WeakScriptMessageHandler?
    private var webViewTileMessageHandler: WebViewTileScriptMessageHandler?
    private var trustedLinkMessageHandler: TrustedLinkScriptMessageHandler?
    private var windowMessageHandler: NativeWindowScriptMessageHandler?
    private var navigationRetryTimer: Timer?
    private var cleanedUp = false
    private var isRetrying = false
    private(set) var windowActive = false
    /// Whether the window is on screen at all. Starts true because a window is
    /// visible when it opens, and `windowDidChangeOcclusionState` only fires on
    /// a change. Distinct from `windowActive`, which tracks key focus: Commando
    /// is watched while you work in another app, so losing focus must not park
    /// the UI - only being genuinely covered or minimised should.
    private(set) var windowPresenting = true
    private var detachedWebPaneIds: [String] = []

    init(
        configuration: DesktopConfiguration = .current(),
        role: DesktopWindowRole = .workspace,
        windowCommandHandler: (any DesktopWindowCommandHandling)? = nil,
        confirmationPresenter: any JavaScriptConfirmationPresenting = AppKitJavaScriptConfirmationPresenter(),
        textInputPresenter: any JavaScriptTextInputPresenting = AppKitJavaScriptTextInputPresenter(),
        externalURLHandler: (any ExternalURLHandling)? = nil,
        pasteboard: NSPasteboard = .general
    ) {
        self.configuration = configuration
        self.role = role
        self.confirmationPresenter = confirmationPresenter
        self.textInputPresenter = textInputPresenter
        admission = WebContentAdmission(origin: configuration.webOrigin)
        let externalURLHandler = externalURLHandler ?? SafeExternalURLHandler(
            privilegedOrigin: configuration.webOrigin
        )
        self.externalURLHandler = externalURLHandler
        windowBridge = NativeWindowBridge(commandHandler: windowCommandHandler, pasteboard: pasteboard)
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: 1_180, height: 760))
        let webConfiguration = WKWebViewConfiguration()
        webView = WKWebView(frame: rootView.bounds, configuration: webConfiguration)
        overlay = TerminalOverlayView(frame: rootView.bounds)
        connectionStatusView = ConnectionStatusView(frame: rootView.bounds)
        bridge = NativeTerminalBridge(
            webView: webView,
            overlay: overlay,
            prefersMetal: configuration.prefersMetal,
            externalURLHandler: externalURLHandler
        )
        webViewTiles = WebViewTileBridge(
            webView: webView,
            overlay: overlay,
            externalURLHandler: externalURLHandler
        )
        super.init()

        let handler = WeakScriptMessageHandler(receiver: bridge, admission: admission)
        scriptMessageHandler = handler
        webConfiguration.userContentController.add(
            handler,
            name: NativeTerminalProtocol.handlerName
        )
        let tileHandler = WebViewTileScriptMessageHandler(bridge: webViewTiles, admission: admission)
        webViewTileMessageHandler = tileHandler
        webConfiguration.userContentController.add(
            tileHandler,
            name: WebViewTileProtocol.handlerName
        )
        let trustedLinkHandler = TrustedLinkScriptMessageHandler(
            admission: admission,
            externalURLHandler: externalURLHandler
        )
        trustedLinkMessageHandler = trustedLinkHandler
        webConfiguration.userContentController.add(
            trustedLinkHandler,
            contentWorld: TrustedLinkBridge.contentWorld,
            name: TrustedLinkBridge.handlerName
        )
        webConfiguration.userContentController.addUserScript(TrustedLinkBridge.userScript)
        let windowHandler = NativeWindowScriptMessageHandler(
            bridge: windowBridge,
            admission: admission
        )
        windowMessageHandler = windowHandler
        webConfiguration.userContentController.add(
            windowHandler,
            name: NativeWindowProtocol.handlerName
        )
        webConfiguration.userContentController.add(
            windowHandler,
            name: NativeWindowProtocol.clipboardHandlerName
        )

        webView.autoresizingMask = [.width, .height]
        overlay.autoresizingMask = [.width, .height]
        connectionStatusView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif

        rootView.addSubview(webView)
        rootView.addSubview(overlay, positioned: .above, relativeTo: webView)
        rootView.addSubview(connectionStatusView, positioned: .above, relativeTo: overlay)
        loadWebApplication()
    }

    func reapplyTerminalFrames() {
        bridge.reapplyFrames()
        webViewTiles.reapplyFrames()
    }

    func setWindowActive(_ active: Bool) {
        guard !cleanedUp, active != windowActive else { return }
        windowActive = active
        publishWindowActivity()
    }

    func setWindowPresenting(_ presenting: Bool) {
        guard !cleanedUp, presenting != windowPresenting else { return }
        windowPresenting = presenting
        publishWindowPresenting()
    }

    func authorizeClipboardWrite() {
        windowBridge.authorizeClipboardWrite()
    }

    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?) {
        windowBridge.commandHandler = handler
    }

    func setDetachedWebPaneIds(_ webPaneIds: [String]) {
        detachedWebPaneIds = webPaneIds.sorted()
        publishDetachedWebPaneIds()
    }

    func applyZoomPercent(_ percent: Int) {
        let percent = ZoomPreference.sanitize(percent)
        guard percent != zoomPercent else { return }
        zoomPercent = percent
        pushZoom()
    }

    @objc func reload(_ sender: Any?) {
        guard !cleanedUp else { return }
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        isRetrying = false
        if webView.reload() == nil {
            loadWebApplication()
        }
    }

    func cleanUp() {
        guard !cleanedUp else { return }
        cleanedUp = true
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        bridge.cleanUp()
        webViewTiles.cleanUp()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeTerminalProtocol.handlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: WebViewTileProtocol.handlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: TrustedLinkBridge.handlerName,
            contentWorld: TrustedLinkBridge.contentWorld
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeWindowProtocol.handlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeWindowProtocol.clipboardHandlerName
        )
        webView.configuration.userContentController.removeAllUserScripts()
        scriptMessageHandler = nil
        webViewTileMessageHandler = nil
        trustedLinkMessageHandler = nil
        windowMessageHandler = nil
        windowBridge.commandHandler = nil
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        // Subframes (web pane tile iframes) may load http(s) content from any
        // origin: only the app's own markup creates iframes, and the daemon's
        // CSP frame-src constrains them in production. The main-frame policy
        // below would otherwise cancel every off-origin tile.
        if let targetFrame = navigationAction.targetFrame, !targetFrame.isMainFrame {
            decisionHandler(
                SubframeNavigationPolicy.allows(navigationAction.request.url) ? .allow : .cancel
            )
            return
        }
        let disposition = externalURLHandler.handle(
            navigationAction.request.url,
            source: .webNavigation(
                opensInNewWindow: navigationAction.targetFrame == nil
            )
        )
        guard disposition == .allowInWebView else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func presentJavaScriptConfirmation(_ message: String) async -> Bool {
        await confirmationPresenter.present(
            message: message,
            in: webView.window
        )
    }

    func presentJavaScriptTextInput(_ message: String, defaultText: String?) async -> String? {
        await textInputPresenter.present(
            message: message,
            defaultText: defaultText,
            in: webView.window
        )
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.pageWasReplaced()
        webViewTiles.pageWasReplaced()
        connectionStatusView.show(isRetrying ? .retrying : .connecting, origin: configuration.webOrigin)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        isRetrying = false
        connectionStatusView.hide()
        pushZoom()
        publishWindowActivity()
        publishWindowPresenting()
        publishDetachedWebPaneIds()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        if (error as NSError).code != NSURLErrorCancelled {
            scheduleNavigationRetry()
        }
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: any Error
    ) {
        if (error as NSError).code != NSURLErrorCancelled {
            scheduleNavigationRetry()
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.pageWasReplaced()
        webViewTiles.pageWasReplaced()
        scheduleNavigationRetry()
    }

    private func loadWebApplication() {
        guard !cleanedUp else { return }
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        connectionStatusView.show(isRetrying ? .retrying : .connecting, origin: configuration.webOrigin)
        webView.load(URLRequest(
            url: role.applicationURL(baseURL: configuration.webURL),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 10
        ))
    }

    /// Pushes the current zoom out to everything that renders at a scale. Kept
    /// separate from `applyZoomPercent` so a finished navigation can re-assert an
    /// unchanged percent — a reload resets `pageZoom` even though nothing changed.
    private func pushZoom() {
        webView.pageZoom = zoomScale
        bridge.setZoomScale(zoomScale)
        webViewTiles.setZoomScale(zoomScale)
        webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'))")
    }

    private func publishWindowActivity() {
        webView.callAsyncJavaScript(
            """
            window.__commandoDesktopWindowActive = active;
            window.dispatchEvent(new CustomEvent("commando:desktop-window-active", { detail: active }));
            """,
            arguments: ["active": windowActive],
            in: nil,
            in: .page
        ) { _ in }
    }

    private func publishWindowPresenting() {
        webView.callAsyncJavaScript(
            """
            window.__commandoDesktopWindowPresenting = presenting;
            window.dispatchEvent(new CustomEvent("commando:desktop-window-presenting", { detail: presenting }));
            """,
            arguments: ["presenting": windowPresenting],
            in: nil,
            in: .page
        ) { _ in }
    }

    private func publishDetachedWebPaneIds() {
        let windowRole: [String: Any]
        switch role {
        case .workspace:
            windowRole = ["kind": "workspace"]
        case let .webPane(id):
            windowRole = ["kind": "web-pane", "webPaneId": id]
        }
        webView.callAsyncJavaScript(
            """
            window.__commandoDesktopWindowRole = role;
            window.__commandoDetachedWebPaneIds = webPaneIds;
            window.dispatchEvent(new CustomEvent(
              "commando:desktop-detached-web-panes",
              { detail: webPaneIds }
            ));
            """,
            arguments: [
                "role": windowRole,
                "webPaneIds": detachedWebPaneIds,
            ],
            in: nil,
            in: .page
        ) { _ in }
    }

    private func scheduleNavigationRetry() {
        guard !cleanedUp, navigationRetryTimer == nil else { return }
        isRetrying = true
        connectionStatusView.show(.retrying, origin: configuration.webOrigin)
        navigationRetryTimer = Timer.scheduledTimer(
            timeInterval: 0.75,
            target: self,
            selector: #selector(retryNavigation(_:)),
            userInfo: nil,
            repeats: false
        )
    }

    @objc
    private func retryNavigation(_ timer: Timer) {
        navigationRetryTimer = nil
        loadWebApplication()
    }
}

extension DesktopWebHost: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let disposition = externalURLHandler.handle(
            navigationAction.request.url,
            source: .webNavigation(
                opensInNewWindow: navigationAction.targetFrame == nil
            )
        )
        if disposition == .allowInWebView {
            webView.load(navigationAction.request)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async -> Bool {
        await presentJavaScriptConfirmation(message)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo
    ) async -> String? {
        await presentJavaScriptTextInput(prompt, defaultText: defaultText)
    }
}
