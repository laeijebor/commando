import XCTest
import WebKit
@testable import CommandoDesktop

@MainActor
final class WebViewTileBridgeTests: XCTestCase {
    private final class ScriptCapture: @unchecked Sendable {
        var script: String?
        var arguments: [String: Any]?
        var completion: WebViewTileScriptCompletion?
        var callCount = 0
    }

    private func makeBridge(
        events: NSMutableArray,
        scriptEvaluator: WebViewTileScriptEvaluator? = nil
    ) -> (WebViewTileBridge, TerminalOverlayView) {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 1_200, height: 800))
        let bridge: WebViewTileBridge
        if let scriptEvaluator {
            bridge = WebViewTileBridge(
                webView: nil,
                overlay: overlay,
                scriptEvaluator: scriptEvaluator,
                eventObserver: { event in events.add(event) }
            )
        } else {
            bridge = WebViewTileBridge(
                webView: nil,
                overlay: overlay,
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
            "visibleRegions": [["x": 100, "y": 50, "width": 400, "height": 300]],
            "resizeOwner": false,
            "order": 0,
        ]))

        let hostView = overlay.subviews.compactMap { $0 as? WebViewTileHostView }.first
        XCTAssertNotNil(hostView)
        XCTAssertEqual(hostView?.isHidden, false)
        XCTAssertEqual(hostView?.visibleRegions.count, 1)

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
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, completion in
            capture.callCount += 1
            capture.script = script
            capture.arguments = arguments
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

    func testDocumentRevisionSuppressesStaleInspectCompletion() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, completion in
            capture.script = script
            capture.arguments = arguments
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

    func testResolveSelectorsValidatesBoundsAndEmitsOnlyRequestedAnchors() throws {
        let events = NSMutableArray()
        let capture = ScriptCapture()
        let (bridge, overlay) = makeBridge(events: events) { _, script, arguments, completion in
            capture.callCount += 1
            capture.script = script
            capture.arguments = arguments
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
}
