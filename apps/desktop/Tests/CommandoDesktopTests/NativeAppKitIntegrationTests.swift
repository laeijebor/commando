import AppKit
import QuartzCore
import WebKit
import XCTest
@testable import CommandoDesktop

@MainActor
private final class IntegrationNavigationDelegate: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, any Error>?

    func load(_ html: String, baseURL: URL, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.loadHTMLString(html, baseURL: baseURL)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume()
        continuation = nil
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: any Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

@MainActor
private final class IntegrationFeedbackHandler: NSObject, WKScriptMessageHandler {
    var receive: (([String: Any]) -> Void)?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        receive?(message.body as? [String: Any] ?? [:])
    }
}

@MainActor
private final class IntegrationURLOpenerSpy: SystemURLOpening {
    private(set) var openedURLs: [URL] = []
    var didOpen: ((URL) -> Void)?

    func open(_ url: URL) -> Bool {
        openedURLs.append(url)
        didOpen?(url)
        return true
    }
}

@MainActor
private struct IntegrationURLFailureReporter: ExternalURLOpenFailureReporting {
    func reportFailure(opening url: URL) {}
}

@MainActor
private final class NativeAppKitHarness {
    static let size = CGSize(width: 320, height: 240)
    static let origin = URL(string: "http://127.0.0.1:5173")!

    let rootView = NSView(frame: NSRect(origin: .zero, size: size))
    let webView: WKWebView
    let overlay = TerminalOverlayView(frame: NSRect(origin: .zero, size: size))
    let window: NSWindow
    let bridge: NativeTerminalBridge
    let pasteboard = NSPasteboard(name: .init("CommandoAppKitIntegrationTests.\(UUID().uuidString)"))
    let opener = IntegrationURLOpenerSpy()
    let feedback = IntegrationFeedbackHandler()

    private let navigationDelegate = IntegrationNavigationDelegate()
    private let nativeMessageHandler: WeakScriptMessageHandler
    private let trustedLinkMessageHandler: TrustedLinkScriptMessageHandler

    init() {
        _ = NSApplication.shared
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(feedback, name: "integrationFeedback")
        configuration.userContentController.addUserScript(TrustedLinkBridge.userScript)
        webView = WKWebView(frame: NSRect(origin: .zero, size: Self.size), configuration: configuration)

        let admission = WebContentAdmission(origin: WebOrigin(url: Self.origin)!)
        let externalURLHandler = SafeExternalURLHandler(
            privilegedOrigin: WebOrigin(url: Self.origin),
            opener: opener,
            failureReporter: IntegrationURLFailureReporter()
        )
        bridge = NativeTerminalBridge(
            webView: webView,
            overlay: overlay,
            prefersMetal: false,
            pasteboard: pasteboard,
            externalURLHandler: externalURLHandler
        )
        nativeMessageHandler = WeakScriptMessageHandler(receiver: bridge, admission: admission)
        trustedLinkMessageHandler = TrustedLinkScriptMessageHandler(
            admission: admission,
            externalURLHandler: externalURLHandler
        )
        configuration.userContentController.add(
            nativeMessageHandler,
            name: NativeTerminalProtocol.handlerName
        )
        configuration.userContentController.add(
            trustedLinkMessageHandler,
            contentWorld: TrustedLinkBridge.contentWorld,
            name: TrustedLinkBridge.handlerName
        )

        webView.navigationDelegate = navigationDelegate
        webView.autoresizingMask = [.width, .height]
        overlay.autoresizingMask = [.width, .height]
        rootView.addSubview(webView)
        rootView.addSubview(overlay, positioned: .above, relativeTo: webView)

        window = NSWindow(
            contentRect: rootView.bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.contentView = rootView
        window.orderFront(nil)
    }

    deinit {
        MainActor.assumeIsolated {
            bridge.cleanUp()
            pasteboard.clearContents()
            webView.configuration.userContentController.removeAllScriptMessageHandlers()
            webView.configuration.userContentController.removeAllUserScripts()
            window.contentView = nil
            window.orderOut(nil)
        }
    }

    func loadPage(extraBody: String = "") async throws {
        try await navigationDelegate.load(
            """
            <!doctype html>
            <html>
              <head>
                <style>
                  html, body { margin: 0; width: 100%; height: 100%; background: rgb(18, 66, 180); }
                  #external { position: fixed; left: 20px; top: 20px; width: 160px; height: 60px; }
                  #hole-button {
                    position: fixed;
                    left: 100px;
                    top: 40px;
                    width: 120px;
                    height: 120px;
                    border: 0;
                    background: rgb(18, 66, 180);
                    color: white;
                  }
                </style>
              </head>
              <body>
                <a id="external" href="https://example.com/docs" target="_blank">External</a>
                <button id="hole-button">Web content</button>
                \(extraBody)
                <script>
                  window.nativeEvents = [];
                  window.webClicks = [];
                  window.__commandoNativeTerminalReceive = (event) => {
                    window.nativeEvents.push(event);
                    if (event.type === "pane.context_menu") window.lastMenu = event.payload;
                    if (event.type === "pane.selection_copied") window.selectionFeedback = true;
                    window.webkit.messageHandlers.integrationFeedback.postMessage({
                      channel: "native",
                      event,
                    });
                  };
                  document.addEventListener("click", (event) => {
                    const payload = {
                      channel: "click",
                      id: event.target.id,
                      trusted: event.isTrusted,
                    };
                    window.webClicks.push(payload);
                    window.webkit.messageHandlers.integrationFeedback.postMessage(payload);
                  });
                </script>
              </body>
            </html>
            """,
            baseURL: Self.origin,
            in: webView
        )
    }

    func createTerminal(
        visibleRegions: [[String: Any]]? = nil,
        text: String = "alpha beta gamma"
    ) throws -> HostedTerminalView {
        let identity = PaneIdentity(paneId: "%1", attachmentId: "integration-1")
        bridge.receiveNativeTerminalMessage(body: message(
            sequence: 1,
            type: "bridge.connect",
            payload: ["supportedVersions": [1]]
        ))
        bridge.receiveNativeTerminalMessage(body: message(
            sequence: 2,
            type: "pane.attach",
            payload: identityPayload(identity).merging([
                "ariaLabel": "Integration terminal",
                "accessibilityEnabled": true,
                "keyShortcuts": ["Meta+C", "Meta+V"],
            ], uniquingKeysWith: { _, new in new })
        ))
        bridge.receiveNativeTerminalMessage(body: message(
            sequence: 3,
            type: "pane.reset",
            payload: identityPayload(identity).merging([
                "data": Data(text.utf8).base64EncodedString(),
                "cols": 40,
                "rows": 6,
                "revision": 1,
            ], uniquingKeysWith: { _, new in new })
        ))
        bridge.receiveNativeTerminalMessage(body: message(
            sequence: 4,
            type: "pane.frame",
            payload: identityPayload(identity).merging([
                "x": 40,
                "y": 40,
                "width": 240,
                "height": 120,
                "scale": Double(window.backingScaleFactor),
                "visible": true,
                "visibleRegions": visibleRegions ?? [
                    ["x": 40, "y": 40, "width": 240, "height": 120],
                ],
                "resizeOwner": true,
                "order": 0,
            ], uniquingKeysWith: { _, new in new })
        ))
        return try XCTUnwrap(
            overlay.subviews
                .flatMap(\.subviews)
                .compactMap { $0 as? HostedTerminalView }
                .first
        )
    }

    func sendMouseGesture(
        from start: CGPoint,
        to end: CGPoint,
        modifiers: NSEvent.ModifierFlags = []
    ) {
        let events: [(NSEvent.EventType, CGPoint)] = start == end
            ? [(.leftMouseDown, start), (.leftMouseUp, end)]
            : [(.leftMouseDown, start), (.leftMouseDragged, end), (.leftMouseUp, end)]
        guard let target = rootView.hitTest(start) else {
            XCTFail("Synthetic AppKit mouse gesture had no hit-test target")
            return
        }
        for (index, item) in events.enumerated() {
            guard let event = NSEvent.mouseEvent(
                with: item.0,
                location: item.1,
                modifierFlags: modifiers,
                timestamp: TimeInterval(index),
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: index,
                clickCount: 1,
                pressure: 1
            ) else {
                XCTFail("Could not create synthetic AppKit mouse event")
                return
            }
            switch item.0 {
            case .leftMouseDown:
                target.mouseDown(with: event)
            case .leftMouseDragged:
                target.mouseDragged(with: event)
            case .leftMouseUp:
                target.mouseUp(with: event)
            default:
                XCTFail("Unsupported synthetic AppKit event type")
            }
        }
    }

    func terminalMouseEvent(
        type: NSEvent.EventType,
        localPoint: CGPoint,
        in view: NSView,
        modifiers: NSEvent.ModifierFlags = []
    ) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(
            with: type,
            location: view.convert(localPoint, to: nil),
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ))
    }

    func evaluate<T>(_ script: String, as type: T.Type = T.self) async throws -> T {
        let value = try await webView.evaluateJavaScript(script)
        return try XCTUnwrap(value as? T)
    }

    private func message(
        sequence: Int,
        type: String,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "protocol": NativeTerminalProtocol.name,
            "version": NativeTerminalProtocol.version,
            "pageId": "integration-page",
            "sequence": sequence,
            "type": type,
            "payload": payload,
        ]
    }

    private func identityPayload(_ identity: PaneIdentity) -> [String: Any] {
        ["paneId": identity.paneId, "attachmentId": identity.attachmentId]
    }
}

@MainActor
final class NativeAppKitIntegrationTests: XCTestCase {
    func testOptionRightClickCrossesTerminalBridgeAndUpdatesPageMenuState() async throws {
        let harness = NativeAppKitHarness()
        try await harness.loadPage()
        let terminal = try harness.createTerminal()
        let feedbackReceived = expectation(description: "page received context-menu event")
        var receivedEvent: [String: Any]?
        harness.feedback.receive = { message in
            guard message["channel"] as? String == "native",
                  let event = message["event"] as? [String: Any],
                  event["type"] as? String == "pane.context_menu"
            else { return }
            receivedEvent = event
            feedbackReceived.fulfill()
        }

        terminal.rightMouseDown(with: try harness.terminalMouseEvent(
            type: .rightMouseDown,
            localPoint: CGPoint(x: 60, y: 60),
            in: terminal,
            modifiers: .option
        ))
        await fulfillment(of: [feedbackReceived], timeout: 2)

        let payload = try XCTUnwrap(receivedEvent?["payload"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(payload["x"] as? NSNumber).doubleValue, 100, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(payload["y"] as? NSNumber).doubleValue, 100, accuracy: 0.001)
        let menu: [String: Any] = try await harness.evaluate("window.lastMenu")
        XCTAssertEqual(menu["paneId"] as? String, "%1")
        // The context menu is DOM content, so the web view (not the terminal)
        // must own keyboard focus while it is open.
        XCTAssertFalse(harness.window.firstResponder === terminal)
        let responderView = try XCTUnwrap(harness.window.firstResponder as? NSView)
        XCTAssertTrue(responderView === harness.webView || responderView.isDescendant(of: harness.webView))
    }

    func testScriptClickFailsTrustGateAndIsolatedTrustedDispatchReachesOpener() async throws {
        let harness = NativeAppKitHarness()
        try await harness.loadPage()
        let scriptClickReceived = expectation(description: "script click completed")
        var scriptClickTrusted: Bool?
        harness.feedback.receive = { message in
            guard message["channel"] as? String == "click",
                  message["id"] as? String == "external"
            else { return }
            scriptClickTrusted = message["trusted"] as? Bool
            scriptClickReceived.fulfill()
        }

        _ = try await harness.webView.evaluateJavaScript("document.getElementById('external').click()")
        await fulfillment(of: [scriptClickReceived], timeout: 2)
        XCTAssertEqual(scriptClickTrusted, false)
        XCTAssertTrue(harness.opener.openedURLs.isEmpty)

        let externalOpenReceived = expectation(description: "external opener invoked")
        let trustedDispatchCompleted = expectation(description: "trusted isolated-world dispatch completed")
        harness.opener.didOpen = { _ in externalOpenReceived.fulfill() }

        harness.webView.callAsyncJavaScript(
            """
            window.webkit.messageHandlers.commandoTrustedLink.postMessage(request);
            return true;
            """,
            arguments: [
                "request": [
                    "url": "https://example.com/docs",
                    "opensInNewWindow": true,
                ],
            ],
            in: nil,
            in: TrustedLinkBridge.contentWorld
        ) { result in
            if case let .failure(error) = result {
                XCTFail("Trusted isolated-world dispatch failed: \(error)")
            }
            trustedDispatchCompleted.fulfill()
        }
        await fulfillment(of: [trustedDispatchCompleted, externalOpenReceived], timeout: 2)

        XCTAssertEqual(harness.opener.openedURLs, [URL(string: "https://example.com/docs")!])
    }

    func testExactOptionSelectionBypassesMouseReportingCopiesAndNotifiesPage() async throws {
        let harness = NativeAppKitHarness()
        try await harness.loadPage()
        let terminal = try harness.createTerminal()
        terminal.feed(text: "\u{1b}[?1000h")
        XCTAssertNotEqual(terminal.getTerminal().mouseMode, .off)
        let feedbackReceived = expectation(description: "page received selection-copy feedback")
        harness.feedback.receive = { message in
            guard message["channel"] as? String == "native",
                  let event = message["event"] as? [String: Any],
                  event["type"] as? String == "pane.selection_copied"
            else { return }
            feedbackReceived.fulfill()
        }
        let rowY = terminal.bounds.height - 10

        terminal.mouseDown(with: try harness.terminalMouseEvent(
            type: .leftMouseDown,
            localPoint: CGPoint(x: 10, y: rowY),
            in: terminal,
            modifiers: .option
        ))
        terminal.mouseDragged(with: try harness.terminalMouseEvent(
            type: .leftMouseDragged,
            localPoint: CGPoint(x: 12, y: rowY),
            in: terminal,
            modifiers: .option
        ))
        terminal.mouseDragged(with: try harness.terminalMouseEvent(
            type: .leftMouseDragged,
            localPoint: CGPoint(x: 100, y: rowY),
            in: terminal,
            modifiers: .option
        ))
        terminal.mouseUp(with: try harness.terminalMouseEvent(
            type: .leftMouseUp,
            localPoint: CGPoint(x: 100, y: rowY),
            in: terminal,
            modifiers: .option
        ))
        await fulfillment(of: [feedbackReceived], timeout: 2)

        let copied = try XCTUnwrap(harness.pasteboard.string(forType: .string))
        XCTAssertFalse(copied.isEmpty)
        XCTAssertEqual(copied, terminal.getSelection())
        XCTAssertTrue(copied.contains("beta"), "Unexpected selection: \(copied)")
        XCTAssertEqual(terminal.accessibilitySelectedText(), copied)
        let nativeInputCount: Int = try await harness.evaluate(
            "window.nativeEvents.filter((event) => event.type === 'pane.input_bytes').length"
        )
        XCTAssertEqual(nativeInputCount, 0)
        let pageFeedback: Bool = try await harness.evaluate("window.selectionFeedback === true")
        XCTAssertTrue(pageFeedback)
    }

    func testPartialTerminalMaskCompositesOffscreenAndRoutesHoleClicksToWebView() async throws {
        let harness = NativeAppKitHarness()
        try await harness.loadPage()
        let terminal = try harness.createTerminal(visibleRegions: [
            ["x": 40, "y": 40, "width": 60, "height": 120],
            ["x": 220, "y": 40, "width": 60, "height": 120],
        ])
        XCTAssertFalse(terminal.isUsingMetalRenderer)
        let leftTerminalPoint = CGPoint(x: 70, y: 140)
        let webHolePoint = CGPoint(x: 160, y: 140)
        let rightTerminalPoint = CGPoint(x: 250, y: 140)

        let leftHit = harness.rootView.hitTest(leftTerminalPoint)
        let holeHit = harness.rootView.hitTest(webHolePoint)
        let rightHit = harness.rootView.hitTest(rightTerminalPoint)
        XCTAssertTrue(leftHit === terminal || leftHit?.isDescendant(of: terminal) == true)
        XCTAssertTrue(holeHit === harness.webView || holeHit?.isDescendant(of: harness.webView) == true)
        XCTAssertTrue(rightHit === terminal || rightHit?.isDescendant(of: terminal) == true)

        let holeClickReceived = expectation(description: "web button clicked through mask hole")
        harness.feedback.receive = { message in
            guard message["channel"] as? String == "click",
                  message["id"] as? String == "hole-button",
                  message["trusted"] as? Bool == true
            else { return }
            holeClickReceived.fulfill()
        }
        harness.sendMouseGesture(from: webHolePoint, to: webHolePoint)
        await fulfillment(of: [holeClickReceived], timeout: 2)
        harness.sendMouseGesture(from: leftTerminalPoint, to: leftTerminalPoint)
        let webClickCount: Int = try await harness.evaluate("window.webClicks.length")
        XCTAssertEqual(webClickCount, 1)

        harness.rootView.wantsLayer = true
        harness.webView.wantsLayer = true
        harness.overlay.wantsLayer = true
        harness.webView.layer?.backgroundColor = NSColor(
            calibratedRed: 18 / 255,
            green: 66 / 255,
            blue: 180 / 255,
            alpha: 1
        ).cgColor
        harness.rootView.layoutSubtreeIfNeeded()
        harness.rootView.displayIfNeeded()
        CATransaction.flush()
        let image = try offscreenBitmap(of: harness.rootView)
        let leftColor = try XCTUnwrap(image.colorAt(x: 70, y: 140)?.usingColorSpace(.deviceRGB))
        let holeColor = try XCTUnwrap(image.colorAt(x: 160, y: 140)?.usingColorSpace(.deviceRGB))
        let rightColor = try XCTUnwrap(image.colorAt(x: 250, y: 140)?.usingColorSpace(.deviceRGB))
        let webColor = try XCTUnwrap(image.colorAt(x: 20, y: 20)?.usingColorSpace(.deviceRGB))

        XCTAssertLessThan(colorDistance(holeColor, webColor), 0.05)
        XCTAssertGreaterThan(colorDistance(leftColor, holeColor), 0.2)
        XCTAssertGreaterThan(colorDistance(rightColor, holeColor), 0.2)
    }

    func testWebViewTileHostMaskRevealsUnderlyingReviewUI() async throws {
        let harness = NativeAppKitHarness()
        try await harness.loadPage(extraBody: """
            <div id="review-card"></div>
            <style>
              #review-card {
                position: fixed;
                left: 100px;
                top: 40px;
                width: 120px;
                height: 120px;
                background: rgb(24, 190, 90);
              }
            </style>
            """)
        let externalURLHandler = SafeExternalURLHandler(
            privilegedOrigin: WebOrigin(url: NativeAppKitHarness.origin),
            opener: harness.opener,
            failureReporter: IntegrationURLFailureReporter()
        )
        let loaded = expectation(description: "native web tile loaded")
        let tile = WebViewTile(
            identity: PaneIdentity(paneId: "w-integration", attachmentId: "integration-web-1"),
            url: NativeAppKitHarness.origin,
            externalURLHandler: externalURLHandler,
            scriptEvaluator: { _, _, _, _, completion in
                completion(.failure(NSError(domain: "unused", code: 1)))
            },
            eventSink: { _, event in
                if case .loaded = event { loaded.fulfill() }
            }
        )
        defer { tile.destroy() }
        tile.hostView.frame = harness.overlay.bounds
        harness.overlay.addSubview(tile.hostView)
        tile.apply(
            placement: TerminalPlacement(
                frame: CGRect(x: 40, y: 80, width: 240, height: 120),
                visibleFrames: [
                    CGRect(x: 40, y: 80, width: 60, height: 120),
                    CGRect(x: 220, y: 80, width: 60, height: 120),
                ],
                isHidden: false
            ),
            frame: PaneFramePayload(
                identity: tile.identity,
                x: 40,
                y: 40,
                width: 240,
                height: 120,
                scale: Double(harness.window.backingScaleFactor),
                visible: true,
                visibleRegions: [
                    .init(x: 40, y: 40, width: 60, height: 120),
                    .init(x: 220, y: 40, width: 60, height: 120),
                ],
                resizeOwner: false,
                order: 0
            )
        )
        tile.webView.loadHTMLString(
            "<style>html,body{margin:0;width:100%;height:100%;background:rgb(190,35,35)}</style>",
            baseURL: NativeAppKitHarness.origin
        )
        await fulfillment(of: [loaded], timeout: 2)

        harness.rootView.wantsLayer = true
        harness.webView.wantsLayer = true
        harness.overlay.wantsLayer = true
        harness.rootView.layoutSubtreeIfNeeded()
        harness.rootView.displayIfNeeded()
        CATransaction.flush()
        let image = try offscreenBitmap(of: harness.rootView)
        let leftColor = try XCTUnwrap(image.colorAt(x: 70, y: 140)?.usingColorSpace(.deviceRGB))
        let holeColor = try XCTUnwrap(image.colorAt(x: 160, y: 140)?.usingColorSpace(.deviceRGB))
        let rightColor = try XCTUnwrap(image.colorAt(x: 250, y: 140)?.usingColorSpace(.deviceRGB))

        XCTAssertGreaterThan(holeColor.greenComponent, holeColor.redComponent)
        XCTAssertGreaterThan(colorDistance(leftColor, holeColor), 0.2)
        XCTAssertGreaterThan(colorDistance(rightColor, holeColor), 0.2)
    }

    func testWebViewTilePageResponseBindingAndPendingSnapshot() async throws {
        let harness = NativeAppKitHarness()
        let externalURLHandler = SafeExternalURLHandler(
            privilegedOrigin: WebOrigin(url: NativeAppKitHarness.origin),
            opener: harness.opener,
            failureReporter: IntegrationURLFailureReporter()
        )
        let loaded = expectation(description: "native response page loaded")
        let sameDocumentLoaded = expectation(description: "same-document URL published")
        let responseReceived = expectation(description: "native page response received")
        let sameDocumentResponseReceived = expectation(description: "same-document response received")
        var didLoad = false
        var waitingForSameDocument = false
        var responseCount = 0
        var latestLoadedURL: String?
        var receivedPayload: String?
        var receivedURL: String?
        let tile = WebViewTile(
            identity: PaneIdentity(paneId: "w-integration", attachmentId: "integration-web-response"),
            url: NativeAppKitHarness.origin,
            externalURLHandler: externalURLHandler,
            scriptEvaluator: { webView, script, arguments, contentWorld, completion in
                webView.callAsyncJavaScript(
                    script,
                    arguments: arguments,
                    in: nil,
                    in: contentWorld,
                    completionHandler: completion
                )
            },
            pageResponsesEnabled: true,
            eventSink: { _, event in
                switch event {
                case let .loaded(url):
                    latestLoadedURL = url
                    if waitingForSameDocument {
                        waitingForSameDocument = false
                        sameDocumentLoaded.fulfill()
                    } else if !didLoad {
                        didLoad = true
                        loaded.fulfill()
                    }
                case let .pageResponse(payload, url):
                    responseCount += 1
                    receivedPayload = payload
                    receivedURL = url
                    if responseCount == 1 {
                        responseReceived.fulfill()
                    } else if responseCount == 2 {
                        sameDocumentResponseReceived.fulfill()
                    }
                case .failed:
                    break
                }
            }
        )
        defer { tile.destroy() }
        tile.presentPendingSnapshot(pageUrl: "http://127.0.0.1:5173/", snapshot: [
            "version": 1,
            "controls": [[
                "queueKey": "plan",
                "response": ["question": "Which plan?", "answer": "Pro"],
            ]],
        ])
        tile.webView.loadHTMLString(
            "<html><body>Native response fixture</body></html>",
            baseURL: NativeAppKitHarness.origin
        )
        await fulfillment(of: [loaded], timeout: 2)

        let bindingType = try await tile.webView.evaluateJavaScript(
            "typeof window.__commandoRedlineQueue"
        ) as? String
        XCTAssertEqual(bindingType, "function")
        _ = try await tile.webView.evaluateJavaScript(
            "window.__commandoRedlineQueue(JSON.stringify({question:'Which plan?',answer:'Pro',queueKey:'plan'})); true"
        )
        await fulfillment(of: [responseReceived], timeout: 2)
        XCTAssertEqual(receivedURL, "http://127.0.0.1:5173/")
        XCTAssertEqual(
            receivedPayload,
            "{\"question\":\"Which plan?\",\"answer\":\"Pro\",\"queueKey\":\"plan\"}"
        )

        var queuedAnswer: String?
        for _ in 0..<20 {
            queuedAnswer = try await tile.webView.evaluateJavaScript(
                "window.__commandoRedlinePendingSnapshot?.controls?.[0]?.response?.answer"
            ) as? String
            if queuedAnswer != nil { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(queuedAnswer, "Pro")

        waitingForSameDocument = true
        _ = try await tile.webView.evaluateJavaScript(
            "history.pushState({}, '', '/after'); true"
        )
        await fulfillment(of: [sameDocumentLoaded], timeout: 2)
        XCTAssertEqual(latestLoadedURL, "http://127.0.0.1:5173/after")
        var clearedCount: Int?
        for _ in 0..<20 {
            clearedCount = try await tile.webView.evaluateJavaScript(
                "window.__commandoRedlinePendingSnapshot?.controls?.length"
            ) as? Int
            if clearedCount == 0 { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(clearedCount, 0)
        tile.presentPendingSnapshot(pageUrl: "http://127.0.0.1:5173/after", snapshot: [
            "version": 1,
            "controls": [[
                "queueKey": "plan",
                "response": ["question": "Which plan?", "answer": "Team"],
            ]],
        ])
        var sameDocumentAnswer: String?
        for _ in 0..<20 {
            sameDocumentAnswer = try await tile.webView.evaluateJavaScript(
                "window.__commandoRedlinePendingSnapshot?.controls?.[0]?.response?.answer"
            ) as? String
            if sameDocumentAnswer == "Team" { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(sameDocumentAnswer, "Team")
        _ = try await tile.webView.evaluateJavaScript(
            "window.__commandoRedlineQueue(JSON.stringify({question:'After?',answer:'Yes'})); true"
        )
        await fulfillment(of: [sameDocumentResponseReceived], timeout: 2)
        XCTAssertEqual(receivedURL, "http://127.0.0.1:5173/after")
        XCTAssertEqual(responseCount, 2)
    }

    private func offscreenBitmap(of view: NSView) throws -> NSBitmapImageRep {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(view.bounds.width),
            pixelsHigh: Int(view.bounds.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        let graphicsContext = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphicsContext
        view.layer?.render(in: graphicsContext.cgContext)
        graphicsContext.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return bitmap
    }

    private func colorDistance(_ left: NSColor, _ right: NSColor) -> CGFloat {
        abs(left.redComponent - right.redComponent) +
            abs(left.greenComponent - right.greenComponent) +
            abs(left.blueComponent - right.blueComponent)
    }
}
