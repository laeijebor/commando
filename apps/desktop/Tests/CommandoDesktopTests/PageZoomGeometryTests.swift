import AppKit
import WebKit
import XCTest
@testable import CommandoDesktop

/// Guards the coordinate contract between WebKit and `TerminalGeometry`.
///
/// The page reports pane rects in CSS pixels and WebKit folds `pageZoom` into
/// `window.devicePixelRatio`, which the web side sends as `payload.scale`. The
/// geometry must therefore turn that ratio into points exactly once. A real
/// `WKWebView` does the measuring here instead of a hand-written payload, so
/// this fails both if the geometry re-applies zoom and if WebKit ever stops
/// carrying zoom in the ratio.
@MainActor
final class PageZoomGeometryTests: XCTestCase {
    private struct MeasuredFrame {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let scale: Double
    }

    func testAZoomedPaneIsPlacedWhereThePageDrewIt() async throws {
        let overlaySize = CGSize(width: 1_000, height: 700)
        let window = NSWindow(
            contentRect: .init(origin: .zero, size: overlaySize),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        let root = NSView(frame: .init(origin: .zero, size: overlaySize))
        window.contentView = root
        // The other real-webview tests in this suite order their window in
        // before laying out; WebKit is not obliged to lay out for a view that
        // has never been on screen.
        window.orderFront(nil)
        let webView = WKWebView(frame: root.bounds)
        root.addSubview(webView)
        let overlay = TerminalOverlayView(frame: root.bounds)
        root.addSubview(overlay)

        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        defer { host.destroyAll() }

        // `full` spans the whole viewport; `inset` sits a quarter of the way in
        // on both axes at half size, so a mis-scaled placement shows up as a
        // wrong origin as well as a wrong size.
        webView.loadHTMLString(
            """
            <body style="margin:0">
              <div id="full" style="position:fixed;inset:0"></div>
              <div id="inset" style="position:fixed;left:25%;top:25%;width:50%;height:50%"></div>
            </body>
            """,
            baseURL: URL(string: "http://127.0.0.1:5173")!
        )
        try await waitForLoad(webView)

        // Baseline the ratio while unzoomed. Comparing the zoomed reading
        // against this, rather than against the window's backing scale, keeps
        // the assertion honest on a mixed-DPI setup where the window's scale
        // and the page's need not agree.
        let unzoomedScale = try await measure("full", in: webView).scale

        let zoomPercent = 125
        let zoomScale = CGFloat(zoomPercent) / 100
        webView.pageZoom = zoomScale
        host.setZoomScale(zoomScale)
        // Page zoom relays out asynchronously; measure only once it has landed.
        try await waitForCSSViewport(webView, width: overlaySize.width / zoomScale)

        for (elementId, expected) in [
            ("full", CGRect(origin: .zero, size: overlaySize)),
            ("inset", CGRect(x: 250, y: 175, width: 500, height: 350)),
        ] {
            let measured = try await measure(elementId, in: webView)
            XCTAssertEqual(
                measured.scale,
                unzoomedScale * Double(zoomScale),
                accuracy: 0.001,
                "WebKit no longer folds pageZoom into devicePixelRatio"
            )

            let identity = PaneIdentity(paneId: "%1", attachmentId: elementId)
            host.attach(.init(identity: identity, ariaLabel: "Terminal"))
            XCTAssertTrue(host.applyFrame(.init(
                identity: identity,
                x: measured.x,
                y: measured.y,
                width: measured.width,
                height: measured.height,
                scale: measured.scale,
                visible: true,
                visibleRegions: [.init(
                    x: measured.x,
                    y: measured.y,
                    width: measured.width,
                    height: measured.height
                )],
                resizeOwner: true,
                order: 0
            )))

            let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
            XCTAssertFalse(surface.view.isHidden)
            assertEqual(surface.backdropView.frame, expected, elementId)
            assertEqual(surface.view.frame, expected, elementId)
        }
    }

    private func assertEqual(
        _ actual: CGRect,
        _ expected: CGRect,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        // Sub-point tolerance: the page rounds CSS pixels to layout units.
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.5, label, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.5, label, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 0.5, label, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 0.5, label, file: file, line: line)
    }

    private func measure(_ elementId: String, in webView: WKWebView) async throws -> MeasuredFrame {
        let result = try await webView.evaluateJavaScript(
            """
            (() => {
              const r = document.getElementById('\(elementId)').getBoundingClientRect();
              return [r.left, r.top, r.width, r.height, window.devicePixelRatio];
            })()
            """
        )
        let values = try XCTUnwrap(result as? [NSNumber])
        XCTAssertEqual(values.count, 5)
        return MeasuredFrame(
            x: values[0].doubleValue,
            y: values[1].doubleValue,
            width: values[2].doubleValue,
            height: values[3].doubleValue,
            scale: values[4].doubleValue
        )
    }

    private func waitForLoad(_ webView: WKWebView) async throws {
        try await poll("page load") {
            let ready = try? await webView.evaluateJavaScript(
                "!!document.getElementById('inset')"
            )
            return (ready as? NSNumber)?.boolValue == true
        }
    }

    private func waitForCSSViewport(_ webView: WKWebView, width: CGFloat) async throws {
        try await poll("zoomed relayout") {
            let inner = try? await webView.evaluateJavaScript("window.innerWidth")
            guard let value = (inner as? NSNumber)?.doubleValue else { return false }
            return abs(value - Double(width)) <= 1
        }
    }

    private func poll(
        _ what: String,
        until condition: () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }
}
