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

    func testScriptClicksCannotOpenExternalOrSameOriginPopupLinks() async throws {
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
        host.webView.stopLoading()
        host.webView.loadHTMLString(
            """
            <a id="external" href="https://example.com" target="_blank">External</a>
            <a id="same-origin" href="/other" target="_blank">Same origin popup</a>
            <script>window.testPageReady = true;</script>
            """,
            baseURL: origin
        )
        defer { host.cleanUp() }

        var ready = false
        for _ in 0..<100 {
            if let result = try? await host.webView.evaluateJavaScript("window.testPageReady === true"),
               (result as? NSNumber)?.boolValue == true {
                ready = true
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(ready)

        _ = try await host.webView.evaluateJavaScript(
            "document.getElementById('external').click(); document.getElementById('same-origin').click();"
        )
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertTrue(opener.openedURLs.isEmpty)
        XCTAssertEqual(host.webView.url?.host, origin.host)
        XCTAssertEqual(host.webView.configuration.userContentController.userScripts.count, 1)
    }
}
