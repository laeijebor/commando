import AppKit
import WebKit

private let nativeTerminalHandlerName = "nativeTerminal"
private let webInterfaceURL = URL(string: "http://127.0.0.1:5190/?shell=swift")!

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
    WKNavigationDelegate
{
    let rootView: NSView

    private let webView: WKWebView
    private let terminalScrollView: NSScrollView
    private let terminalTextView: NSTextView
    private var scriptMessageHandler: WeakScriptMessageHandler?
    private var navigationRetryTimer: Timer?
    private var latestFrame: TerminalFramePayload?

    override init() {
        rootView = NSView(frame: NSRect(x: 0, y: 0, width: 1180, height: 760))

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: rootView.bounds, configuration: configuration)
        terminalScrollView = NSScrollView(frame: .zero)
        terminalTextView = NSTextView(frame: .zero)

        super.init()

        let handler = WeakScriptMessageHandler(receiver: self)
        scriptMessageHandler = handler
        configuration.userContentController.add(handler, name: nativeTerminalHandlerName)

        configureWebView()
        configureTerminalSurface()

        rootView.addSubview(webView)
        rootView.addSubview(terminalScrollView, positioned: .above, relativeTo: webView)
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
    }

    func reapplyTerminalFrame() {
        guard let latestFrame else { return }
        apply(frame: latestFrame)
    }

    func receiveNativeTerminalMessage(body: Any) {
        do {
            switch try NativeTerminalMessage.decode(jsonObject: body) {
            case let .frame(frame):
                latestFrame = frame
                apply(frame: frame)
            case .focus:
                terminalTextView.window?.makeFirstResponder(terminalTextView)
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
        terminalScrollView.isHidden = true
        terminalScrollView.borderType = .noBorder
        terminalScrollView.drawsBackground = true
        terminalScrollView.backgroundColor = NSColor(
            calibratedRed: 0.035,
            green: 0.031,
            blue: 0.059,
            alpha: 1
        )
        terminalScrollView.hasVerticalScroller = true
        terminalScrollView.autohidesScrollers = true

        terminalTextView.isEditable = true
        terminalTextView.isSelectable = true
        terminalTextView.isRichText = false
        terminalTextView.allowsUndo = true
        terminalTextView.drawsBackground = true
        terminalTextView.backgroundColor = terminalScrollView.backgroundColor
        terminalTextView.textColor = NSColor(
            calibratedRed: 0.82,
            green: 0.95,
            blue: 0.87,
            alpha: 1
        )
        terminalTextView.insertionPointColor = .white
        terminalTextView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminalTextView.textContainerInset = NSSize(width: 12, height: 10)
        terminalTextView.minSize = NSSize(width: 0, height: 0)
        terminalTextView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        terminalTextView.isVerticallyResizable = true
        terminalTextView.isHorizontallyResizable = false
        terminalTextView.autoresizingMask = [.width]
        terminalTextView.textContainer?.widthTracksTextView = true
        terminalTextView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )
        terminalTextView.string = """
        Last login: Sat Aug  1 09:41:12 on ttys003
        commando native-terminal spike

        $ pwd
        /Users/developer/commando
        $ git status --short
         M spikes/native-terminal/swift/Sources/NativeTerminalSwiftSpike/AppMain.swift
        $ swift run NativeTerminalSwiftSpike
        Native AppKit surface attached to the shared WebKit shell.

        $ _
        """

        terminalScrollView.documentView = terminalTextView
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

        terminalScrollView.frame = NSRect(
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height
        )
        terminalScrollView.isHidden = placement.isHidden

        if !placement.isHidden {
            var documentFrame = terminalTextView.frame
            documentFrame.size.width = terminalScrollView.contentSize.width
            documentFrame.size.height = max(documentFrame.height, terminalScrollView.contentSize.height)
            terminalTextView.frame = documentFrame
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
