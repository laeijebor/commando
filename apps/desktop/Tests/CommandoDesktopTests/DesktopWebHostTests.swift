import AppKit
import WebKit
import XCTest
@testable import CommandoDesktop

@MainActor
private final class ConfirmationPresenterSpy: JavaScriptConfirmationPresenting {
    private(set) var messages: [String] = []
    var result = false

    func present(
        message: String,
        in window: NSWindow?
    ) async -> Bool {
        messages.append(message)
        return result
    }
}

@MainActor
private final class WebHostURLOpenerSpy: SystemURLOpening {
    private(set) var openedURLs: [URL] = []

    func open(_ url: URL) -> Bool {
        openedURLs.append(url)
        return true
    }
}

@MainActor
private struct WebHostURLFailureReporterStub: ExternalURLOpenFailureReporting {
    func reportFailure(opening url: URL) {}
}

@MainActor
final class DesktopWebHostTests: XCTestCase {
    func testZoomNotifiesThePageToRepublishNativeFrames() async throws {
        let url = URL(string: "http://127.0.0.1:5173")!
        let host = DesktopWebHost(configuration: .init(webURL: url, prefersMetal: false))
        host.webView.stopLoading()
        host.webView.loadHTMLString(
            """
            <script>
              window.zoomLayoutEvents = 0;
              window.addEventListener('resize', () => { window.zoomLayoutEvents += 1; });
            </script>
            """,
            baseURL: url
        )

        var isReady = false
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript(
                "typeof window.zoomLayoutEvents === 'number'"
            ),
               let ready = result as? NSNumber,
               ready.boolValue {
                isReady = true
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(isReady)

        host.zoomIn(nil)
        var layoutEvents = 0
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript("window.zoomLayoutEvents"),
               let count = result as? NSNumber,
               count.intValue > 0
            {
                layoutEvents = count.intValue
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertGreaterThanOrEqual(layoutEvents, 1)
        host.cleanUp()
    }

    func testZoomActionsScaleWebContentInBoundedSteps() {
        let host = DesktopWebHost()

        host.zoomIn(nil)
        XCTAssertEqual(host.zoomPercent, 110)
        XCTAssertEqual(host.webView.pageZoom, 1.1, accuracy: 0.001)
        host.zoomOut(nil)
        XCTAssertEqual(host.zoomPercent, 100)
        XCTAssertEqual(host.webView.pageZoom, 1, accuracy: 0.001)

        for _ in 0..<20 { host.zoomOut(nil) }
        XCTAssertEqual(host.zoomPercent, DesktopWebHost.minimumZoomPercent)
        XCTAssertEqual(host.webView.pageZoom, 0.5, accuracy: 0.001)
        for _ in 0..<20 { host.zoomIn(nil) }
        XCTAssertEqual(host.zoomPercent, DesktopWebHost.maximumZoomPercent)
        XCTAssertEqual(host.webView.pageZoom, 2, accuracy: 0.001)
        host.cleanUp()
    }

    func testDesktopWindowsExchangeSameOriginBroadcastChannelMessages() async throws {
        let origin = URL(string: "http://127.0.0.1:5173")!
        let channelName = "commando-window-test-\(UUID().uuidString)"
        let first = DesktopWebHost(configuration: .init(webURL: origin, prefersMetal: false))
        let second = DesktopWebHost(configuration: .init(webURL: origin, prefersMetal: false))
        defer {
            first.cleanUp()
            second.cleanUp()
        }
        for host in [first, second] {
            host.webView.stopLoading()
            host.webView.loadHTMLString(
                """
                <script>
                  window.receivedToken = null;
                  window.tokenChannel = new BroadcastChannel('\(channelName)');
                  window.tokenChannel.onmessage = (event) => { window.receivedToken = event.data; };
                  window.channelReady = true;
                </script>
                """,
                baseURL: origin
            )
        }

        for host in [first, second] {
            var ready = false
            for _ in 0..<100 {
                if let value = try? await host.webView.evaluateJavaScript("window.channelReady === true"),
                   (value as? NSNumber)?.boolValue == true {
                    ready = true
                    break
                }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(ready)
        }
        _ = try await first.webView.evaluateJavaScript(
            "window.tokenChannel.postMessage('shared-in-memory-token')"
        )

        var received: String?
        for _ in 0..<100 {
            if let value = try? await second.webView.evaluateJavaScript("window.receivedToken"),
               let token = value as? String {
                received = token
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(received, "shared-in-memory-token")
    }

    func testInstallsUIDelegateAndRoutesJavaScriptConfirmation() async {
        let presenter = ConfirmationPresenterSpy()
        presenter.result = true
        let host = DesktopWebHost(confirmationPresenter: presenter)

        XCTAssertTrue(host.webView.uiDelegate === host)
        XCTAssertTrue(host.responds(to: #selector(
            WKUIDelegate.webView(
                _:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:
            )
        )))
        XCTAssertTrue(host.responds(to: #selector(
            WKUIDelegate.webView(
                _:createWebViewWith:for:windowFeatures:
            )
        )))

        let result = await host.presentJavaScriptConfirmation("Kill pane api?")
        XCTAssertEqual(presenter.messages, ["Kill pane api?"])
        XCTAssertEqual(result, true)

        host.cleanUp()
        XCTAssertNil(host.webView.uiDelegate)
    }

    func testConfirmationWithoutAWindowCancelsSafely() async {
        let presenter = AppKitJavaScriptConfirmationPresenter()

        let result = await presenter.present(message: "Kill pane api?", in: nil)

        XCTAssertEqual(result, false)
    }

    func testTrustedPortLinksWaitForBubbleCancellationAndRejectSyntheticClicks() async throws {
        let origin = URL(string: "http://127.0.0.1:5173")!
        let opener = WebHostURLOpenerSpy()
        let handler = SafeExternalURLHandler(
            privilegedOrigin: WebOrigin(url: origin),
            opener: opener,
            failureReporter: WebHostURLFailureReporterStub()
        )
        let host = DesktopWebHost(
            configuration: .init(webURL: origin, prefersMetal: false),
            externalURLHandler: handler
        )
        let window = NSWindow(
            contentRect: host.rootView.bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.contentView = host.rootView
        window.orderFront(nil)
        host.webView.stopLoading()
        host.webView.loadHTMLString(
            """
            <style>
              html, body { margin: 0; width: 100%; height: 100%; }
              #port { position: fixed; inset: 0; display: block; }
            </style>
            <a id="port" href="https://example.com/port" target="_blank">3000</a>
            <script>
              window.portClicks = [];
              const port = document.getElementById("port");
              port.addEventListener("click", (event) => {
                if (!event.metaKey && !event.ctrlKey && !event.shiftKey) event.preventDefault();
                window.portClicks.push({
                  trusted: event.isTrusted,
                  modified: event.metaKey,
                  prevented: event.defaultPrevented,
                });
              });
              window.testPageReady = true;
            </script>
            """,
            baseURL: origin
        )
        defer {
            host.cleanUp()
            window.contentView = nil
            window.orderOut(nil)
        }

        var ready = false
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript(
                "window.testPageReady === true && document.readyState === 'complete'"
            ),
               (result as? NSNumber)?.boolValue == true {
                ready = true
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(ready)

        func clickPort(modifiers: NSEvent.ModifierFlags = []) throws {
            let location = host.webView.convert(
                NSPoint(x: host.webView.bounds.midX, y: host.webView.bounds.midY),
                to: nil
            )
            for (index, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
                let event = try XCTUnwrap(NSEvent.mouseEvent(
                    with: type,
                    location: location,
                    modifierFlags: modifiers,
                    timestamp: TimeInterval(index),
                    windowNumber: window.windowNumber,
                    context: nil,
                    eventNumber: index,
                    clickCount: 1,
                    pressure: 1
                ))
                if type == .leftMouseDown {
                    host.webView.mouseDown(with: event)
                } else {
                    host.webView.mouseUp(with: event)
                }
            }
        }

        try clickPort()
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript("window.portClicks.length"),
               (result as? NSNumber)?.intValue == 1 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(opener.openedURLs.isEmpty)

        try clickPort(modifiers: .command)
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript("window.portClicks.length"),
               (result as? NSNumber)?.intValue == 2,
               opener.openedURLs.count == 1 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(opener.openedURLs, [URL(string: "https://example.com/port")!])

        _ = try await host.webView.evaluateJavaScript(
            """
            document.getElementById("port").dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              button: 0,
              metaKey: true,
            }));
            """
        )
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript("window.portClicks.length"),
               (result as? NSNumber)?.intValue == 3 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(50))

        let clickValue = try await host.webView.evaluateJavaScript("window.portClicks")
        let clicks = try XCTUnwrap(clickValue as? [[String: Any]])
        XCTAssertEqual(clicks.count, 3)
        XCTAssertEqual(clicks[0]["trusted"] as? Bool, true)
        XCTAssertEqual(clicks[0]["prevented"] as? Bool, true)
        XCTAssertEqual(clicks[1]["trusted"] as? Bool, true)
        XCTAssertEqual(clicks[1]["modified"] as? Bool, true)
        XCTAssertEqual(clicks[1]["prevented"] as? Bool, false)
        XCTAssertEqual(clicks[2]["trusted"] as? Bool, false)
        XCTAssertEqual(opener.openedURLs, [URL(string: "https://example.com/port")!])
        XCTAssertEqual(host.webView.configuration.userContentController.userScripts.count, 1)
    }

    func testPublishesDesktopWindowActivityIntoThePage() async throws {
        let origin = URL(string: "http://127.0.0.1:5173")!
        let host = DesktopWebHost(configuration: .init(webURL: origin, prefersMetal: false))
        host.webView.stopLoading()
        host.webView.loadHTMLString("<main>Ready</main>", baseURL: origin)
        defer { host.cleanUp() }

        for _ in 0..<100 {
            if (try? await host.webView.evaluateJavaScript("document.readyState")) as? String == "complete" {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        host.setWindowActive(true)

        var active = false
        for _ in 0..<100 {
            if let value = try? await host.webView.evaluateJavaScript(
                "window.__commandoDesktopWindowActive === true"
            ),
               (value as? NSNumber)?.boolValue == true {
                active = true
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(active)
        XCTAssertTrue(host.windowActive)
    }
}
