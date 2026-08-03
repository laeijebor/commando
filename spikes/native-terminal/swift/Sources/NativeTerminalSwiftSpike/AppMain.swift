import AppKit
import SwiftTerm
import WebKit

private let nativeTerminalHandlerName = "nativeTerminal"
private let shouldUseMetalRendering: Bool = {
    #if DEBUG
    ProcessInfo.processInfo.environment["COMMANDO_NATIVE_TERMINAL_METAL"] == "1"
    #else
    ProcessInfo.processInfo.environment["COMMANDO_NATIVE_TERMINAL_METAL"] != "0"
    #endif
}()
private let webInterfaceURL: URL = {
    let uiPort = ProcessInfo.processInfo.environment["COMMANDO_NATIVE_UI_PORT"] ?? "5190"
    var components = URLComponents(string: "http://127.0.0.1:\(uiPort)/")!
    components.queryItems = [URLQueryItem(name: "shell", value: "swift")]
    if let paneId = ProcessInfo.processInfo.environment["COMMANDO_PANE_ID"], !paneId.isEmpty {
        components.queryItems?.append(URLQueryItem(name: "pane", value: paneId))
    }
    if let token = ProcessInfo.processInfo.environment["COMMANDO_TOKEN"], !token.isEmpty {
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "token", value: token)]
        components.percentEncodedFragment = fragment.percentEncodedQuery?.replacingOccurrences(
            of: "+",
            with: "%2B"
        )
    }
    return components.url!
}()

@MainActor
private protocol NativeTerminalMessageReceiving: AnyObject {
    func receiveNativeTerminalMessage(body: Any)
}

@MainActor
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var receiver: (any NativeTerminalMessageReceiving)?

    init(receiver: any NativeTerminalMessageReceiving) {
        self.receiver = receiver
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        receiver?.receiveNativeTerminalMessage(body: message.body)
    }
}

@MainActor
private final class NativeTerminalCoordinator: NSObject,
    NativeTerminalMessageReceiving,
    WKNavigationDelegate,
    @preconcurrency TerminalViewDelegate
{
    let rootView: NSView

    private let webView: WKWebView
    private let terminalView: TerminalView
    private var scriptMessageHandler: WeakScriptMessageHandler?
    private var navigationRetryTimer: Timer?
    private var latestFrame: TerminalFramePayload?
    private var terminalOrderGate = NativeTerminalOrderGate()
    private var metalRenderingAttempted = false

    override init() {
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: 1180, height: 760))

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: rootView.bounds, configuration: configuration)
        terminalView = TerminalView(frame: .zero)

        super.init()

        let handler = WeakScriptMessageHandler(receiver: self)
        scriptMessageHandler = handler
        configuration.userContentController.add(handler, name: nativeTerminalHandlerName)

        configureWebView()
        configureTerminalSurface()

        rootView.addSubview(webView)
        rootView.addSubview(terminalView, positioned: .above, relativeTo: webView)
        loadWebInterface()
    }

    func cleanUp() {
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: nativeTerminalHandlerName
        )
        scriptMessageHandler = nil
        terminalView.terminalDelegate = nil
        if terminalView.isUsingMetalRenderer {
            try? terminalView.setUseMetal(false)
        }
        terminalView.removeFromSuperview()
    }

    func reapplyTerminalFrame() {
        guard let latestFrame else { return }
        apply(frame: latestFrame)
    }

    private func enableMetalRenderingIfAvailable() {
        guard !metalRenderingAttempted, terminalView.window != nil else { return }
        metalRenderingAttempted = true
        guard shouldUseMetalRendering else { return }

        do {
            try terminalView.setUseMetal(true)
        } catch {
            NSLog(
                "NativeTerminalSwiftSpike continuing with CoreGraphics rendering: %@",
                String(describing: error)
            )
        }
    }

    func receiveNativeTerminalMessage(body: Any) {
        do {
            switch try NativeTerminalMessage.decode(jsonObject: body) {
            case let .frame(frame):
                latestFrame = frame
                apply(frame: frame)
            case .focus:
                terminalView.window?.makeFirstResponder(terminalView)
            case let .reset(reset):
                apply(reset: reset)
            case let .data(data):
                apply(data: data)
            }
        } catch {
            NSLog("NativeTerminalSwiftSpike ignored malformed nativeTerminal message: %@", String(describing: error))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
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
        scheduleNavigationRetry()
    }

    private func configureWebView() {
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self

        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    private func configureTerminalSurface() {
        let backgroundColor = NSColor(
            calibratedRed: 0.035,
            green: 0.031,
            blue: 0.059,
            alpha: 1
        )
        let foregroundColor = NSColor(
            calibratedRed: 0.82,
            green: 0.95,
            blue: 0.87,
            alpha: 1
        )

        terminalView.isHidden = true
        terminalView.clipsToBounds = true
        terminalView.terminalDelegate = self
        terminalView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminalView.nativeBackgroundColor = backgroundColor
        terminalView.nativeForegroundColor = foregroundColor
        terminalView.caretColor = .white
        terminalView.caretViewTracksFocus = true
        terminalView.scrollerStyle = .overlay
        terminalView.layer?.backgroundColor = backgroundColor.cgColor
    }

    private func apply(frame: TerminalFramePayload) {
        let backingScale: CGFloat
        if let windowScale = webView.window?.backingScaleFactor {
            backingScale = windowScale
        } else if let mainScreen = NSScreen.main {
            backingScale = mainScreen.backingScaleFactor
        } else {
            backingScale = frame.scale
        }
        let placement = TerminalGeometry.placement(
            for: frame,
            viewportWidth: webView.bounds.width,
            viewportHeight: webView.bounds.height,
            backingScale: backingScale
        )

        if placement.isHidden, terminalView.isUsingMetalRenderer {
            try? terminalView.setUseMetal(false)
            metalRenderingAttempted = false
        }
        terminalView.frame = NSRect(
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height
        )
        terminalView.isHidden = placement.isHidden
        if !placement.isHidden {
            enableMetalRenderingIfAvailable()
        }
    }

    private func apply(reset: TerminalResetPayload) {
        guard terminalOrderGate.accept(reset: reset) else { return }

        terminalView.resize(cols: reset.cols, rows: reset.rows)
        terminalView.getTerminal().resetToInitialState()
        feed(reset.data)
        // Parse the seed at its captured grid, then restore the actual viewport capacity.
        terminalView.setFrameSize(terminalView.frame.size)
    }

    private func apply(data: TerminalDataPayload) {
        guard terminalOrderGate.accept(data: data) else { return }
        feed(data.data)
    }

    private func feed(_ data: Data) {
        let bytes = [UInt8](data)
        terminalView.feed(byteArray: bytes[...])
    }

    private func sendNativeEvent(_ event: [String: Any]) {
        webView.callAsyncJavaScript(
            """
            if (typeof window.__commandoNativeTerminalEvent === "function") {
                window.__commandoNativeTerminalEvent(event);
            }
            """,
            arguments: ["event": event],
            in: nil,
            in: .page
        ) { result in
            if case let .failure(error) = result {
                NSLog(
                    "NativeTerminalSwiftSpike failed to deliver terminal event: %@",
                    String(describing: error)
                )
            }
        }
    }

    private func loadWebInterface() {
        navigationRetryTimer?.invalidate()
        navigationRetryTimer = nil
        let request = URLRequest(
            url: webInterfaceURL,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 10
        )
        webView.load(request)
    }

    private func scheduleNavigationRetry() {
        guard navigationRetryTimer == nil else { return }

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
        loadWebInterface()
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard newCols > 0, newRows > 0 else { return }
        sendNativeEvent(["kind": "resize", "cols": newCols, "rows": newRows])
    }

    func setTerminalTitle(source: TerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        sendNativeEvent([
            "kind": "input",
            "data": Data(data).base64EncodedString(),
        ])
    }

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}

    func bell(source: TerminalView) {
        NSSound.beep()
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let string = String(data: content, encoding: .utf8) else { return }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([string as NSString])
    }

    func clipboardRead(source: TerminalView) -> Data? {
        nil
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var coordinator: NativeTerminalCoordinator?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let coordinator = NativeTerminalCoordinator()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Commando Native Terminal - Swift/AppKit"
        window.minSize = NSSize(width: 760, height: 540)
        window.isReleasedWhenClosed = false
        window.contentView = coordinator.rootView
        window.delegate = self
        window.center()

        self.coordinator = coordinator
        self.window = window

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        coordinator?.cleanUp()
        coordinator = nil
        window = nil
    }

    func windowDidResize(_ notification: Notification) {
        coordinator?.reapplyTerminalFrame()
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        coordinator?.reapplyTerminalFrame()
    }
}

@main
@MainActor
private struct NativeTerminalSwiftSpikeApp {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()

        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}
