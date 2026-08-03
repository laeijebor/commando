import XCTest
@testable import CommandoDesktop

final class DesktopConfigurationTests: XCTestCase {
    func testOnlyPermitsLoopbackHTTPAndHTTPSURLs() {
        for value in [
            "http://127.0.0.1:5173",
            "https://localhost/app",
            "http://127.42.0.9:4310",
            "http://[::1]:4310",
        ] {
            XCTAssertTrue(DesktopConfiguration.isPermittedWebURL(URL(string: value)!))
        }
        for value in [
            "http://example.com",
            "file:///tmp/index.html",
            "ws://127.0.0.1:4310",
            "http://user@localhost:4310",
            "http://127.example.com:4310",
            "http://127.0.0.999:4310",
        ] {
            XCTAssertFalse(DesktopConfiguration.isPermittedWebURL(URL(string: value)!))
        }
    }

    func testNavigationRequiresExactConfiguredOrigin() {
        let admission = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "http://127.0.0.1:5173/app")!)!
        )

        XCTAssertTrue(admission.allowsNavigation(to: URL(string: "http://127.0.0.1:5173/other")!))
        XCTAssertFalse(admission.allowsNavigation(to: URL(string: "http://127.0.0.1:4310")!))
        XCTAssertFalse(admission.allowsNavigation(to: URL(string: "https://127.0.0.1:5173")!))
        XCTAssertFalse(admission.allowsNavigation(to: URL(string: "http://127.0.0.2:5173")!))
        XCTAssertFalse(admission.allowsNavigation(to: URL(string: "http://localhost:5173")!))
    }

    func testBridgeRequiresMainFrameAndExactSecurityOrigin() {
        let admission = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "https://localhost:443/app")!)!
        )

        XCTAssertTrue(admission.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "https",
            host: "localhost",
            port: 443
        ))
        XCTAssertFalse(admission.allowsBridgeMessage(
            isMainFrame: false,
            scheme: "https",
            host: "localhost",
            port: 443
        ))
        XCTAssertFalse(admission.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "http",
            host: "localhost",
            port: 443
        ))
        XCTAssertFalse(admission.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "https",
            host: "localhost",
            port: 444
        ))
        XCTAssertFalse(admission.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "https",
            host: "127.0.0.1",
            port: 443
        ))
    }

    func testBridgeNormalizesZeroToDefaultHTTPAndHTTPSPorts() {
        let http = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "http://localhost/app")!)!
        )
        let https = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "https://localhost/app")!)!
        )

        XCTAssertTrue(http.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "http",
            host: "localhost",
            port: 0
        ))
        XCTAssertTrue(https.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "https",
            host: "localhost",
            port: 0
        ))
    }

    func testZeroPortStillRejectsWrongSchemeHostAndConfiguredPort() {
        let defaultHTTP = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "http://localhost/app")!)!
        )
        XCTAssertFalse(defaultHTTP.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "https",
            host: "localhost",
            port: 0
        ))
        XCTAssertFalse(defaultHTTP.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "http",
            host: "127.0.0.1",
            port: 0
        ))
        XCTAssertFalse(defaultHTTP.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "http",
            host: "localhost",
            port: 443
        ))

        let customPort = WebContentAdmission(
            origin: WebOrigin(url: URL(string: "http://localhost:4310/app")!)!
        )
        XCTAssertFalse(customPort.allowsBridgeMessage(
            isMainFrame: true,
            scheme: "http",
            host: "localhost",
            port: 0
        ))
    }
}
