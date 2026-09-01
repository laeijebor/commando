import XCTest
import WebKit
@testable import CommandoDesktop

@MainActor
private final class WebViewLoadWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Never>?

    func loadHTML(_ html: String, in webView: WKWebView) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            webView.navigationDelegate = self
            webView.loadHTMLString(html, baseURL: URL(string: "https://example.com/"))
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
        continuation?.resume()
        continuation = nil
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        continuation?.resume()
        continuation = nil
    }
}

private final class WebViewScriptResult: @unchecked Sendable {
    var result: Result<Any, any Error>?
}

@MainActor
final class WebViewTileBridgeTests: XCTestCase {
    private final class ScriptCapture: @unchecked Sendable {
        var script: String?
        var arguments: [String: Any]?
        var contentWorld: WKContentWorld?
        var completion: WebViewTileScriptCompletion?
        var callCount = 0
    }

    private func makeBridge(
        events: NSMutableArray,
        inspectionTimeout: Duration = WebViewTileProtocol.inspectionTimeout,
        scriptEvaluator: WebViewTileScriptEvaluator? = nil
    ) -> (WebViewTileBridge, TerminalOverlayView) {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 1_200, height: 800))
        let bridge: WebViewTileBridge
        if let scriptEvaluator {
            bridge = WebViewTileBridge(
                webView: nil,
                overlay: overlay,
                inspectionTimeout: inspectionTimeout,
                scriptEvaluator: scriptEvaluator,
                eventObserver: { event in events.add(event) }
            )
        } else {
            bridge = WebViewTileBridge(
                webView: nil,
                overlay: overlay,
                inspectionTimeout: inspectionTimeout,
                eventObserver: { event in events.add(event) }
            )
        }
        return (bridge, overlay)
    }

    private func envelope(
        pageId: String = "page-1",
        sequence: Int,
        type: String,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "protocol": "commando.native-webview",
            "version": 1,
            "pageId": pageId,
            "sequence": sequence,
            "type": type,
            "payload": payload,
        ]
    }

    private func connect(_ bridge: WebViewTileBridge) {
        bridge.receive(body: envelope(sequence: 1, type: "bridge.connect", payload: [
            "supportedVersions": [1],
        ]))
    }

    func testConnectRespondsWithCapabilities() {
        let events = NSMutableArray()
        let (bridge, _) = makeBridge(events: events)

        connect(bridge)

        XCTAssertEqual(events.count, 1)
        let event = events[0] as? [String: Any]
        XCTAssertEqual(event?["type"] as? String, "bridge.connected")
        XCTAssertEqual(event?["pageId"] as? String, "page-1")
        let payload = event?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["capabilities"] as? [String], [
            "webview.embed.v1",
            "webview.inspectAtPoint.v1",
            "webview.resolveSelectors.v1",
            "webview.reviewInput.v1",
            "webview.reviewHighlights.v1",
            "webview.pageResponses.v1",
            "webview.hitRegions.v1",
        ])
        XCTAssertEqual(payload?["maxWebViews"] as? Int, WebViewTileProtocol.maxTiles)
    }

    func testAttachCreatesTileAndEmitsAttached() {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)

        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://reactnative.dev/docs",
        ]))

        XCTAssertEqual(bridge.tileCount, 1)
        XCTAssertEqual(overlay.subviews.count, 1)
        let event = events.lastObject as? [String: Any]
        XCTAssertEqual(event?["type"] as? String, "webview.attached")
        let payload = event?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["webPaneId"] as? String, "w-abcd1234")
    }

    func testFinishedNavigationEmitsLoaded() throws {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "http://127.0.0.1:9/",
        ]))
        let hostView = overlay.subviews.compactMap { $0 as? WebViewTileHostView }.first
        let webView = try XCTUnwrap(hostView?.subviews.compactMap { $0 as? WKWebView }.first)
        let delegate = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)

        delegate.webView(webView, didFinish: nil)

        let event = events.lastObject as? [String: Any]
        XCTAssertEqual(event?["type"] as? String, "webview.loaded")
        let payload = event?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["webPaneId"] as? String, "w-abcd1234")
        XCTAssertEqual(payload?["attachmentId"] as? String, "page-1:1")
        XCTAssertEqual(payload?["url"] as? String, "http://127.0.0.1:9/")

        let navigatedURL = try XCTUnwrap(URL(string: "https://example.com/after-navigation"))
        webView.load(URLRequest(url: navigatedURL))
        delegate.webView(webView, didFinish: nil)

        let navigatedEvent = try XCTUnwrap(events.lastObject as? [String: Any])
        let navigatedPayload = try XCTUnwrap(navigatedEvent["payload"] as? [String: Any])
        XCTAssertEqual(navigatedPayload["url"] as? String, navigatedURL.absoluteString)
        XCTAssertEqual(bridge.tileCount, 1)
    }

    func testAttachRejectsNonHTTPURL() {
        let events = NSMutableArray()
        let (bridge, _) = makeBridge(events: events)
        connect(bridge)

        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "file:///etc/passwd",
        ]))

        XCTAssertEqual(bridge.tileCount, 0)
        let event = events.lastObject as? [String: Any]
        XCTAssertEqual(event?["type"] as? String, "webview.failed")
        let payload = event?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["code"] as? String, "invalid_url")
    }

    func testStaleSequenceAndForeignPageAreIgnored() {
        let events = NSMutableArray()
        let (bridge, _) = makeBridge(events: events)
        connect(bridge)

        // Replayed sequence number.
        bridge.receive(body: envelope(sequence: 1, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        // Wrong page id.
        bridge.receive(body: envelope(pageId: "other-page", sequence: 5, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:2",
            "url": "https://example.com/",
        ]))

        XCTAssertEqual(bridge.tileCount, 0)
        XCTAssertEqual(events.count, 1)
    }

    func testDetachRemovesTile() {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))

        bridge.receive(body: envelope(sequence: 3, type: "webview.detach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
        ]))

        XCTAssertEqual(bridge.tileCount, 0)
        XCTAssertEqual(overlay.subviews.count, 0)
        let event = events.lastObject as? [String: Any]
        XCTAssertEqual(event?["type"] as? String, "webview.detached")
    }

    func testFrameAppliesPlacementToTile() {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))

        bridge.receive(body: envelope(sequence: 3, type: "webview.frame", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "x": 100,
            "y": 50,
            "width": 400,
            "height": 300,
            "scale": 1,
            "visible": true,
            "visibleRegions": [
                ["x": 100, "y": 50, "width": 100, "height": 300],
                ["x": 400, "y": 50, "width": 100, "height": 300],
            ],
            "resizeOwner": false,
            "order": 0,
        ]))

        let hostView = overlay.subviews.compactMap { $0 as? WebViewTileHostView }.first
        XCTAssertNotNil(hostView)
        XCTAssertEqual(hostView?.isHidden, false)
        XCTAssertEqual(hostView?.visibleRegions.count, 2)
        let webView = hostView?.subviews.compactMap { $0 as? WKWebView }.first
        let reviewOverlay = hostView?.subviews.compactMap { $0 as? WebViewTileReviewOverlayView }.first
        let mask = hostView?.layer?.mask as? CAShapeLayer
        XCTAssertNotNil(mask)
        XCTAssertNil(webView?.layer?.mask)
        XCTAssertNil(reviewOverlay?.layer?.mask)
        XCTAssertEqual(mask?.frame, hostView?.bounds)
        XCTAssertEqual(mask?.path?.contains(CGPoint(x: 150, y: 500)), true)
        XCTAssertEqual(mask?.path?.contains(CGPoint(x: 300, y: 500)), false)
        XCTAssertEqual(mask?.path?.contains(CGPoint(x: 450, y: 500)), true)

        // A frame reporting no visible regions hides the tile.
        bridge.receive(body: envelope(sequence: 4, type: "webview.frame", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "x": 100,
            "y": 50,
            "width": 400,
            "height": 300,
            "scale": 1,
            "visible": false,
            "visibleRegions": [],
            "resizeOwner": false,
            "order": 0,
        ]))
        XCTAssertEqual(hostView?.isHidden, true)
    }

    func testZoomTracksExistingAndFutureTilesAndScalesNativeHighlights() throws {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.setZoomScale(1.25)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let hostView = try XCTUnwrap(
            overlay.subviews.compactMap { $0 as? WebViewTileHostView }.first
        )
        let webView = try XCTUnwrap(hostView.subviews.compactMap { $0 as? WKWebView }.first)
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        XCTAssertEqual(webView.pageZoom, 1.25, accuracy: 0.001)

        bridge.receive(body: envelope(
            sequence: 3,
            type: "webview.presentReviewHighlights",
            payload: [
                "webPaneId": "w-abcd1234",
                "attachmentId": "page-1:1",
                "highlights": [[
                    "kind": "hover",
                    "rect": ["x": 10, "y": 12, "width": 80, "height": 24],
                ]],
            ]
        ))
        XCTAssertEqual(
            tile.reviewOverlay.highlights.first?.rect,
            CGRect(x: 12.5, y: 15, width: 100, height: 30)
        )

        bridge.setZoomScale(1.5)

        XCTAssertEqual(webView.pageZoom, 1.5, accuracy: 0.001)
        XCTAssertEqual(
            tile.reviewOverlay.highlights.first?.rect,
            CGRect(x: 15, y: 18, width: 120, height: 36)
        )
    }

    func testReconnectDestroysExistingTiles() {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        XCTAssertEqual(bridge.tileCount, 1)

        bridge.receive(body: envelope(pageId: "page-2", sequence: 1, type: "bridge.connect", payload: [
            "supportedVersions": [1],
        ]))

        XCTAssertEqual(bridge.tileCount, 0)
        XCTAssertEqual(overlay.subviews.count, 0)
    }

    func testInspectUsesFixedScriptAndBoundArgumentsThenEmitsCorrelatedResult() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, contentWorld, completion in
            capture.callCount += 1
            capture.script = script
            capture.arguments = arguments
            capture.contentWorld = contentWorld
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        tile.webView(webView, didFinish: nil)

        bridge.receive(body: envelope(sequence: 3, type: "webview.inspectAtPoint", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r1",
            "x": 12,
            "y": 34,
            "grade": "click",
        ]))

        XCTAssertEqual(capture.callCount, 1)
        XCTAssertEqual(capture.script, WebViewTileProtocol.inspectAtPointScript)
        XCTAssertTrue(capture.contentWorld === WKContentWorld.defaultClient)
        XCTAssertTrue(WebViewTileProtocol.inspectAtPointScript.contains(#"`\\${char}`"#))
        XCTAssertEqual(capture.arguments?["inspectX"] as? Double, 12)
        XCTAssertEqual(capture.arguments?["inspectY"] as? Double, 34)
        XCTAssertEqual(capture.arguments?["inspectGrade"] as? String, "click")
        capture.completion?(.success([
            "ok": true,
            "selector": "#target",
            "tag": "button",
            "rect": ["x": 1, "y": 2, "width": 3, "height": 4],
            "text": "Target",
        ]))

        let event = try XCTUnwrap(events.lastObject as? [String: Any])
        XCTAssertEqual(event["type"] as? String, "webview.inspectAtPoint.result")
        let payload = try XCTUnwrap(event["payload"] as? [String: Any])
        XCTAssertEqual(payload["requestId"] as? String, "r1")
        let result = try XCTUnwrap(payload["result"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["selector"] as? String, "#target")
    }

    func testInspectionScriptRunsOutsidePageWorldOverrides() async throws {
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 200))
        let window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = webView
        let waiter = WebViewLoadWaiter()
        await waiter.loadHTML(
            """
            <!doctype html>
            <style>html,body { margin: 0 } #target { width: 120px; height: 80px }</style>
            <button id="target">Target</button>
            <script>document.elementFromPoint = () => null;</script>
            """,
            in: webView
        )

        let scriptResult = WebViewScriptResult()
        let scriptCompleted = expectation(description: "isolated inspection completed")
        webView.callAsyncJavaScript(
            WebViewTileProtocol.inspectAtPointScript,
            arguments: ["inspectX": 10, "inspectY": 10, "inspectGrade": "click"],
            in: nil,
            in: .defaultClient
        ) { result in
            scriptResult.result = result
            scriptCompleted.fulfill()
        }
        await fulfillment(of: [scriptCompleted], timeout: 2)

        let value = try XCTUnwrap(scriptResult.result).get()
        let result = try XCTUnwrap(value as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["selector"] as? String, "#target")
        XCTAssertEqual(result["text"] as? String, "Target")
        webView.navigationDelegate = nil
        window.contentView = nil
        window.orderOut(nil)
    }

    func testDocumentRevisionSuppressesStaleInspectCompletion() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, contentWorld, completion in
            capture.script = script
            capture.arguments = arguments
            capture.contentWorld = contentWorld
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        tile.webView(webView, didFinish: nil)
        bridge.receive(body: envelope(sequence: 3, type: "webview.inspectAtPoint", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-stale",
            "x": 1,
            "y": 2,
            "grade": "hover",
        ]))
        let countBeforeCompletion = events.count

        tile.webView(webView, didStartProvisionalNavigation: nil)
        capture.completion?(.success([
            "ok": true,
            "selector": "#stale",
            "tag": "div",
            "rect": ["x": 1, "y": 2, "width": 3, "height": 4],
        ]))

        XCTAssertEqual(events.count, countBeforeCompletion)
    }

    func testInspectionTimeoutExpiresNativeKeyAndSuppressesLateCompletion() async throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(
            events: events,
            inspectionTimeout: .milliseconds(10)
        ) { _, _, _, _, completion in
            capture.callCount += 1
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        tile.webView(webView, didFinish: nil)
        bridge.receive(body: envelope(sequence: 3, type: "webview.inspectAtPoint", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-timeout",
            "x": 1,
            "y": 2,
            "grade": "hover",
        ]))
        let lateCompletion = capture.completion

        try await Task.sleep(for: .milliseconds(30))

        let timeoutEvent = try XCTUnwrap(events.lastObject as? [String: Any])
        let timeoutPayload = try XCTUnwrap(timeoutEvent["payload"] as? [String: Any])
        let timeoutResult = try XCTUnwrap(timeoutPayload["result"] as? [String: Any])
        XCTAssertEqual(timeoutPayload["requestId"] as? String, "r-timeout")
        XCTAssertEqual(timeoutResult["ok"] as? Bool, false)
        let countAfterTimeout = events.count
        lateCompletion?(.success([
            "ok": true,
            "selector": "#late",
            "tag": "div",
            "rect": ["x": 1, "y": 2, "width": 3, "height": 4],
        ]))
        XCTAssertEqual(events.count, countAfterTimeout)

        bridge.receive(body: envelope(sequence: 4, type: "webview.inspectAtPoint", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-next",
            "x": 1,
            "y": 2,
            "grade": "hover",
        ]))
        XCTAssertEqual(capture.callCount, 2)
    }

    func testResolveSelectorsValidatesBoundsAndEmitsOnlyRequestedAnchors() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, contentWorld, completion in
            capture.callCount += 1
            capture.script = script
            capture.arguments = arguments
            capture.contentWorld = contentWorld
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        tile.webView(webView, didFinish: nil)

        bridge.receive(body: envelope(sequence: 3, type: "webview.resolveSelectors", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-invalid",
            "items": [["noteId": 1, "selector": String(repeating: "x", count: 1_025)]],
        ]))
        XCTAssertEqual(capture.callCount, 0)

        bridge.receive(body: envelope(sequence: 4, type: "webview.resolveSelectors", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r2",
            "items": [["noteId": 7, "selector": "#target"]],
        ]))
        XCTAssertEqual(capture.callCount, 1)
        XCTAssertEqual(capture.script, WebViewTileProtocol.resolveSelectorsScript)
        XCTAssertEqual(
            (capture.arguments?["selectorItems"] as? [[String: Any]])?.first?["selector"] as? String,
            "#target"
        )
        capture.completion?(.success([
            ["noteId": 7, "rect": ["x": 1, "y": 2, "width": 3, "height": 4]],
        ]))

        let event = try XCTUnwrap(events.lastObject as? [String: Any])
        XCTAssertEqual(event["type"] as? String, "webview.resolveSelectors.result")
        let payload = try XCTUnwrap(event["payload"] as? [String: Any])
        XCTAssertEqual(payload["requestId"] as? String, "r2")
        XCTAssertEqual(payload["ok"] as? Bool, true)
        XCTAssertEqual((payload["anchors"] as? [[String: Any]])?.count, 1)
    }

    func testRejectsUnboundedAndNonPositivePageResultRectangles() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, _, _, _, completion in
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)
        tile.webView(webView, didFinish: nil)

        bridge.receive(body: envelope(sequence: 3, type: "webview.inspectAtPoint", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-bad-inspect",
            "x": 1,
            "y": 2,
            "grade": "click",
        ]))
        capture.completion?(.success([
            "ok": true,
            "selector": "#target",
            "tag": "button",
            "rect": ["x": 1, "y": 2, "width": 0, "height": 4],
        ]))
        var event = try XCTUnwrap(events.lastObject as? [String: Any])
        var payload = try XCTUnwrap(event["payload"] as? [String: Any])
        let result = try XCTUnwrap(payload["result"] as? [String: Any])
        XCTAssertEqual(result["ok"] as? Bool, false)

        bridge.receive(body: envelope(sequence: 4, type: "webview.resolveSelectors", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "requestId": "r-bad-anchor",
            "items": [["noteId": 7, "selector": "#target"]],
        ]))
        capture.completion?(.success([[
            "noteId": 7,
            "rect": ["x": 100_001, "y": 2, "width": 3, "height": 4],
        ]]))
        event = try XCTUnwrap(events.lastObject as? [String: Any])
        payload = try XCTUnwrap(event["payload"] as? [String: Any])
        XCTAssertEqual(payload["ok"] as? Bool, false)
    }

    func testReviewInputPassesHitTestingThroughAndCleansUpOnExitAndDetach() throws {
        let events = NSMutableArray()
        let (bridge, overlay) = makeBridge(events: events)
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        bridge.receive(body: envelope(sequence: 3, type: "webview.frame", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "x": 0,
            "y": 0,
            "width": 400,
            "height": 300,
            "scale": 1,
            "visible": true,
            "visibleRegions": [["x": 0, "y": 0, "width": 400, "height": 300]],
            "resizeOwner": false,
            "order": 0,
        ]))
        let hostView = try XCTUnwrap(
            overlay.subviews.compactMap { $0 as? WebViewTileHostView }.first
        )

        XCTAssertFalse(hostView.reviewInputPassThrough)
        bridge.receive(body: envelope(sequence: 4, type: "webview.reviewInput", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "enabled": true,
        ]))
        XCTAssertTrue(hostView.reviewInputPassThrough)
        XCTAssertNil(hostView.hitTest(NSPoint(x: 10, y: 10)))

        bridge.receive(body: envelope(sequence: 5, type: "webview.reviewInput", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "enabled": false,
        ]))
        XCTAssertFalse(hostView.reviewInputPassThrough)

        bridge.receive(body: envelope(sequence: 6, type: "webview.reviewInput", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "enabled": true,
        ]))
        bridge.receive(body: envelope(sequence: 7, type: "webview.detach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
        ]))
        XCTAssertFalse(hostView.reviewInputPassThrough)
        XCTAssertNil(hostView.superview)
    }

    func testReviewHighlightsUseBoundedNativeOverlayWithoutScriptEvaluation() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, contentWorld, completion in
            capture.callCount += 1
            capture.script = script
            capture.arguments = arguments
            capture.contentWorld = contentWorld
            capture.completion = completion
        }
        connect(bridge)
        bridge.receive(body: envelope(sequence: 2, type: "webview.attach", payload: [
            "webPaneId": "w-abcd1234",
            "attachmentId": "page-1:1",
            "url": "https://example.com/",
        ]))
        let webView = try XCTUnwrap(
            overlay.subviews
                .compactMap { $0 as? WebViewTileHostView }
                .first?
                .subviews
                .compactMap { $0 as? WKWebView }
                .first
        )
        let tile = try XCTUnwrap(webView.navigationDelegate as? WebViewTile)

        bridge.receive(body: envelope(
            sequence: 3,
            type: "webview.presentReviewHighlights",
            payload: [
                "webPaneId": "w-abcd1234",
                "attachmentId": "page-1:1",
                "highlights": [[
                    "kind": "response",
                    "selected": true,
                    "rect": ["x": 10, "y": 12, "width": 80, "height": 24],
                ]],
            ]
        ))
        XCTAssertEqual(tile.reviewOverlay.highlights, [WebViewTileReviewHighlight(
            rect: CGRect(x: 10, y: 12, width: 80, height: 24),
            kind: .response,
            selected: true
        )])
        XCTAssertEqual(capture.callCount, 0)

        tile.webView(webView, didStartProvisionalNavigation: nil)
        XCTAssertTrue(tile.reviewOverlay.highlights.isEmpty)

        bridge.receive(body: envelope(
            sequence: 4,
            type: "webview.presentReviewHighlights",
            payload: [
                "webPaneId": "w-abcd1234",
                "attachmentId": "page-1:1",
                "highlights": [[
                    "kind": "response",
                    "selected": true,
                    "rect": ["x": 10, "y": 12, "width": 80, "height": 24],
                ]],
            ]
        ))

        bridge.receive(body: envelope(
            sequence: 5,
            type: "webview.presentReviewHighlights",
            payload: [
                "webPaneId": "w-abcd1234",
                "attachmentId": "page-1:1",
                "highlights": [[
                    "kind": "hover",
                    "rect": ["x": 0, "y": 0, "width": -1, "height": 10],
                ]],
            ]
        ))
        XCTAssertEqual(tile.reviewOverlay.highlights.count, 1)
        XCTAssertEqual(capture.callCount, 0)
    }
}
