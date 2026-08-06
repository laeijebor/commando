import XCTest
@testable import CommandoDesktop

final class SubframeNavigationPolicyTests: XCTestCase {
    func testAllowsHTTPAndHTTPSAnywhere() {
        // Regression: web pane tile iframes were cancelled by the main-frame
        // external-URL policy, stalling every off-origin tile (e.g. a Lavish
        // session on another localhost port) in the desktop app.
        XCTAssertTrue(SubframeNavigationPolicy.allows(URL(string: "http://127.0.0.1:4387/session/abc")))
        XCTAssertTrue(SubframeNavigationPolicy.allows(URL(string: "http://localhost:5173/")))
        XCTAssertTrue(SubframeNavigationPolicy.allows(URL(string: "https://example.com/page")))
    }

    func testCancelsNonWebSchemesAndCredentialedURLs() {
        XCTAssertFalse(SubframeNavigationPolicy.allows(nil))
        XCTAssertFalse(SubframeNavigationPolicy.allows(URL(string: "file:///etc/passwd")))
        XCTAssertFalse(SubframeNavigationPolicy.allows(URL(string: "javascript:alert(1)")))
        XCTAssertFalse(SubframeNavigationPolicy.allows(URL(string: "data:text/html,hi")))
        XCTAssertFalse(SubframeNavigationPolicy.allows(URL(string: "https://user:pw@example.com/")))
    }
}
