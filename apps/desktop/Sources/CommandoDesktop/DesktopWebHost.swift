import AppKit
import WebKit

@MainActor
final class DesktopWebHost: NSObject, WKNavigationDelegate {
    let rootView: NSView
    let webView: WKWebView
    let overlay: TerminalOverlayView
    let connectionStatusView: ConnectionStatusView

    private let configuration: DesktopConfiguration
    private let admission: WebContentAdmission
    private let bridge: NativeTerminalBridge
    private var scriptMessageHandler: WeakScriptMessageHandler?
    private var navigationRetryTimer: Timer?
    private var cleanedUp = false
    private var isRetrying = false

    init(configuration: DesktopConfiguration = .current()) {
        self.configuration = configuration
        admission = WebContentAdmission(origin: configuration.webOrigin)
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: 1_180, height: 760))
        let webConfiguration = WKWebViewConfiguration()
        webView = WKWebView(frame: rootView.bounds, configuration: webConfiguration)
        overlay = TerminalOverlayView(frame: rootView.bounds)
        connectionStatusView = ConnectionStatusView(frame: rootView.bounds)
        bridge = NativeTerminalBridge(
            webView: webView,
            overlay: overlay,
            prefersMetal: configuration.prefersMetal
        )
        super.init()

        let handler = WeakScriptMessageHandler(receiver: bridge, admission: admission)
        scriptMessageHandler = handler
        webConfiguration.userContentController.add(
            handler,
            name: NativeTerminalProtocol.handlerName
        )

        webView.autoresizingMask = [.width, .height]
        overlay.autoresizingMask = [.width, .height]
        connectionStatusView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
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
    }

    func cleanUp() {
        guard !cleanedUp else { return }
        cleanedUp = true
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        bridge.cleanUp()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeTerminalProtocol.handlerName
        )
        scriptMessageHandler = nil
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              admission.allowsNavigation(to: url)
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.pageWasReplaced()
        connectionStatusView.show(isRetrying ? .retrying : .connecting, origin: configuration.webOrigin)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        isRetrying = false
        connectionStatusView.hide()
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
        scheduleNavigationRetry()
    }

    private func loadWebApplication() {
        guard !cleanedUp else { return }
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        connectionStatusView.show(isRetrying ? .retrying : .connecting, origin: configuration.webOrigin)
        webView.load(URLRequest(
            url: configuration.webURL,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 10
        ))
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
