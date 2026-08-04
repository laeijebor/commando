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
final class DesktopWebHost: NSObject, WKNavigationDelegate {
    static let minimumZoomPercent = 50
    static let maximumZoomPercent = 200
    static let zoomStepPercent = 10

    let rootView: NSView
    let webView: WKWebView
    let overlay: TerminalOverlayView
    let connectionStatusView: ConnectionStatusView
    private(set) var zoomPercent = 100

    var zoomScale: CGFloat { CGFloat(zoomPercent) / 100 }

    private let configuration: DesktopConfiguration
    private let admission: WebContentAdmission
    private let bridge: NativeTerminalBridge
    private let confirmationPresenter: any JavaScriptConfirmationPresenting
    private var scriptMessageHandler: WeakScriptMessageHandler?
    private var navigationRetryTimer: Timer?
    private var cleanedUp = false
    private var isRetrying = false

    init(
        configuration: DesktopConfiguration = .current(),
        confirmationPresenter: any JavaScriptConfirmationPresenting = AppKitJavaScriptConfirmationPresenter()
    ) {
        self.configuration = configuration
        self.confirmationPresenter = confirmationPresenter
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
    }

    @objc func zoomOut(_ sender: Any?) {
        setZoomPercent(max(Self.minimumZoomPercent, zoomPercent - Self.zoomStepPercent))
    }

    @objc func zoomIn(_ sender: Any?) {
        setZoomPercent(min(Self.maximumZoomPercent, zoomPercent + Self.zoomStepPercent))
    }

    func cleanUp() {
        guard !cleanedUp else { return }
        cleanedUp = true
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        bridge.cleanUp()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
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

    func presentJavaScriptConfirmation(_ message: String) async -> Bool {
        await confirmationPresenter.present(
            message: message,
            in: webView.window
        )
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

    private func setZoomPercent(_ percent: Int) {
        guard percent != zoomPercent else { return }
        zoomPercent = percent
        webView.pageZoom = zoomScale
        bridge.setZoomScale(zoomScale)
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
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async -> Bool {
        await presentJavaScriptConfirmation(message)
    }
}
