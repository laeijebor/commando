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
private final class TextInputPresenterSpy: JavaScriptTextInputPresenting {
    private(set) var prompts: [(message: String, defaultText: String?)] = []
    var result: String?

    func present(
        message: String,
        defaultText: String?,
        in window: NSWindow?
    ) async -> String? {
        prompts.append((message, defaultText))
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
private final class DesktopWindowCommandHandlerSpy: DesktopWindowCommandHandling {
    private(set) var opened: [String] = []
    private(set) var focused: [String] = []
    private(set) var reattached: [String] = []
    private(set) var zoomCommands: [String] = []

    func openWebPaneWindow(webPaneId: String) { opened.append(webPaneId) }
    func focusWebPaneWindow(webPaneId: String) { focused.append(webPaneId) }
    func reattachWebPaneWindow(webPaneId: String) { reattached.append(webPaneId) }
    func zoomIn() { zoomCommands.append("in") }
    func zoomOut() { zoomCommands.append("out") }
    func actualSize() { zoomCommands.append("actual") }
}

@MainActor
final class DesktopWebHostTests: XCTestCase {
    func testWebPaneRoleAddsOnlyTheFocusedRouteQuery() throws {
        let baseURL = try XCTUnwrap(URL(string: "http://127.0.0.1:5173/?existing=1"))

        let url = DesktopWindowRole.webPane(id: "w-abcd1234").applicationURL(baseURL: baseURL)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))

        XCTAssertEqual(components.path, "/")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "existing", value: "1"),
            URLQueryItem(name: "commandoWindow", value: "web-pane"),
            URLQueryItem(name: "webPaneId", value: "w-abcd1234"),
        ])
        XCTAssertEqual(DesktopWindowRole.workspace.applicationURL(baseURL: baseURL), baseURL)
    }

    func testNativeWindowBridgeRoutesOnlyVersionedValidPaneCommands() {
        let handler = DesktopWindowCommandHandlerSpy()
        let bridge = NativeWindowBridge(commandHandler: handler)

        func receive(_ type: String, id: String, version: Int = 1) {
            bridge.receive(body: [
                "protocol": NativeWindowProtocol.protocolName,
                "version": version,
                "type": type,
                "payload": ["webPaneId": id],
            ])
        }
        receive("web-pane.open", id: "w-abcd1234")
        receive("web-pane.focus", id: "w-abcd1234")
        receive("web-pane.reattach", id: "w-abcd1234")
        receive("web-pane.open", id: "../../bad")
        receive("web-pane.open", id: "w-deadbeef", version: 2)

        XCTAssertEqual(handler.opened, ["w-abcd1234"])
        XCTAssertEqual(handler.focused, ["w-abcd1234"])
        XCTAssertEqual(handler.reattached, ["w-abcd1234"])
    }
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

        host.applyZoomPercent(110)
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

    func testApplyingAZoomPercentScalesWebContentAndIgnoresUnusableValues() {
        let host = DesktopWebHost()

        host.applyZoomPercent(110)
        XCTAssertEqual(host.zoomPercent, 110)
        XCTAssertEqual(host.webView.pageZoom, 1.1, accuracy: 0.001)

        host.applyZoomPercent(ZoomPreference.minimumPercent)
        XCTAssertEqual(host.webView.pageZoom, 0.5, accuracy: 0.001)
        host.applyZoomPercent(ZoomPreference.maximumPercent)
        XCTAssertEqual(host.webView.pageZoom, 2, accuracy: 0.001)

        host.applyZoomPercent(9_000)
        XCTAssertEqual(host.zoomPercent, ZoomPreference.defaultPercent)
        XCTAssertEqual(host.webView.pageZoom, 1, accuracy: 0.001)
        host.cleanUp()
    }

    func testFinishedNavigationReassertsTheCurrentZoom() {
        let host = DesktopWebHost()
        host.applyZoomPercent(130)

        // A reload drops the webview back to unzoomed; finishing navigation must restore it.
        host.webView.pageZoom = 1
        host.webView(host.webView, didFinish: nil)

        XCTAssertEqual(host.zoomPercent, 130)
        XCTAssertEqual(host.webView.pageZoom, 1.3, accuracy: 0.001)
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

    func testInstallsUIDelegateAndRoutesJavaScriptTextInput() async {
        let presenter = TextInputPresenterSpy()
        presenter.result = "renamed-session"
        let host = DesktopWebHost(textInputPresenter: presenter)

        XCTAssertTrue(host.responds(to: #selector(
            WKUIDelegate.webView(
                _:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:
            )
        )))

        let result = await host.presentJavaScriptTextInput(
            "Rename tmux session",
            defaultText: "commando"
        )
        XCTAssertEqual(presenter.prompts.count, 1)
        XCTAssertEqual(presenter.prompts.first?.message, "Rename tmux session")
        XCTAssertEqual(presenter.prompts.first?.defaultText, "commando")
        XCTAssertEqual(result, "renamed-session")

        host.cleanUp()
    }

    func testWindowPromptInPageContentReceivesThePresentedText() async throws {
        let url = URL(string: "http://127.0.0.1:5173")!
        let presenter = TextInputPresenterSpy()
        presenter.result = "renamed-session"
        let host = DesktopWebHost(
            configuration: .init(webURL: url, prefersMetal: false),
            textInputPresenter: presenter
        )
        defer { host.cleanUp() }
        host.webView.stopLoading()
        host.webView.loadHTMLString(
            """
            <script>
              window.promptResult = window.prompt('Rename tmux session', 'commando');
              window.promptDone = true;
            </script>
            """,
            baseURL: url
        )

        var result: String?
        for _ in 0..<200 {
            if let done = try? await host.webView.evaluateJavaScript("window.promptDone === true"),
               (done as? NSNumber)?.boolValue == true {
                result = try await host.webView.evaluateJavaScript("window.promptResult") as? String
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(result, "renamed-session")
        XCTAssertEqual(presenter.prompts.first?.message, "Rename tmux session")
        XCTAssertEqual(presenter.prompts.first?.defaultText, "commando")
    }

    func testTextInputWithoutAWindowCancelsSafely() async {
        let presenter = AppKitJavaScriptTextInputPresenter()

        let result = await presenter.present(
            message: "Rename tmux session",
            defaultText: "commando",
            in: nil
        )

        XCTAssertNil(result)
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

    func testPublishesWindowRoleAndDetachedPaneIdsIntoThePage() async throws {
        let origin = URL(string: "http://127.0.0.1:5173")!
        let host = DesktopWebHost(
            configuration: .init(webURL: origin, prefersMetal: false),
            role: .webPane(id: "w-abcd1234")
        )
        host.webView.stopLoading()
        host.webView.loadHTMLString("<main>Ready</main>", baseURL: origin)
        defer { host.cleanUp() }

        for _ in 0..<100 {
            if (try? await host.webView.evaluateJavaScript("document.readyState")) as? String == "complete" {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        host.setDetachedWebPaneIds(["w-deadbeef", "w-abcd1234"])

        var published = false
        for _ in 0..<100 {
            if let value = try? await host.webView.evaluateJavaScript(
                """
                window.__commandoDesktopWindowRole?.webPaneId === 'w-abcd1234' &&
                window.__commandoDetachedWebPaneIds?.join(',') === 'w-abcd1234,w-deadbeef'
                """
            ),
               (value as? NSNumber)?.boolValue == true {
                published = true
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(published)
    }
}
