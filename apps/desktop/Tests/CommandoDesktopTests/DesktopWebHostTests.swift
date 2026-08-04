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
final class DesktopWebHostTests: XCTestCase {
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
}
