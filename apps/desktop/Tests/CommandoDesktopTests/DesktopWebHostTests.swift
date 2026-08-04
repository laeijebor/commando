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
