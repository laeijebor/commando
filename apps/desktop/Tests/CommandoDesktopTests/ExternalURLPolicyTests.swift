import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
private final class SystemURLOpenerSpy: SystemURLOpening {
    private(set) var openedURLs: [URL] = []
    var result = true

    func open(_ url: URL) -> Bool {
        openedURLs.append(url)
        return result
    }
}

@MainActor
final class ExternalURLPolicyTests: XCTestCase {
    private let origin = WebOrigin(url: URL(string: "http://127.0.0.1:5173/app")!)!

    func testExactConfiguredOriginStaysInPrivilegedWebView() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)

        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "http://127.0.0.1:5173/notes?selected=1#block"),
                source: .webNavigation(userActivated: false, opensInNewWindow: false)
            ),
            .allowInWebView
        )
        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "http://127.0.0.1:5173/new"),
                source: .webNavigation(userActivated: true, opensInNewWindow: true)
            ),
            .allowInWebView
        )
    }

    func testUserActivatedExternalHTTPLinksOpenExternallyIncludingTargetBlankAndLocalhostPorts() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)
        let cases: [(String, ExternalURLSource)] = [
            (
                "https://example.com/docs",
                .webNavigation(userActivated: true, opensInNewWindow: false)
            ),
            (
                "https://example.com/new",
                .webNavigation(userActivated: true, opensInNewWindow: true)
            ),
            (
                "http://localhost:4310/api",
                .webNavigation(userActivated: true, opensInNewWindow: false)
            ),
            (
                "http://127.0.0.1:4310/api",
                .webNavigation(userActivated: true, opensInNewWindow: true)
            ),
        ]

        for (value, source) in cases {
            XCTAssertEqual(
                policy.disposition(for: URL(string: value), source: source),
                .openExternally,
                value
            )
        }
    }

    func testRedirectsCredentialsAndUnsafeSchemesAreCanceled() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)

        for value in [
            "https://example.com/redirected",
            "http://localhost:4310/redirected",
        ] {
            XCTAssertEqual(
                policy.disposition(
                    for: URL(string: value),
                    source: .webNavigation(userActivated: false, opensInNewWindow: false)
                ),
                .cancel,
                value
            )
        }
        for value in [
            "javascript:alert(1)",
            "file:///tmp/private",
            "mailto:security@example.com",
            "http://user:password@127.0.0.1:5173/private",
        ] {
            XCTAssertEqual(
                policy.disposition(
                    for: URL(string: value),
                    source: .webNavigation(userActivated: true, opensInNewWindow: false)
                ),
                .cancel,
                value
            )
        }
        XCTAssertEqual(
            policy.disposition(
                for: nil,
                source: .webNavigation(userActivated: true, opensInNewWindow: true)
            ),
            .cancel
        )
    }

    func testSafeHandlerCallsInjectedOpenerOnlyForExternalDisposition() {
        let opener = SystemURLOpenerSpy()
        let handler = SafeExternalURLHandler(privilegedOrigin: origin, opener: opener)
        let external = URL(string: "https://example.com")!

        XCTAssertEqual(
            handler.handle(
                external,
                source: .webNavigation(userActivated: true, opensInNewWindow: false)
            ),
            .openExternally
        )
        XCTAssertEqual(
            handler.handle(
                URL(string: "http://127.0.0.1:5173/app"),
                source: .webNavigation(userActivated: true, opensInNewWindow: false)
            ),
            .allowInWebView
        )
        XCTAssertEqual(
            handler.handle(
                URL(string: "https://redirect.example.com"),
                source: .webNavigation(userActivated: false, opensInNewWindow: false)
            ),
            .cancel
        )

        XCTAssertEqual(opener.openedURLs, [external])
    }

    func testSwiftTermOSC8LinksUseSafeHandlerForExplicitHTTPAndHTTPSOnly() {
        let opener = SystemURLOpenerSpy()
        let handler = SafeExternalURLHandler(privilegedOrigin: origin, opener: opener)
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "osc-8"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            externalURLHandler: handler,
            eventSink: { _ in }
        )

        surface.requestOpenLink(source: surface.view, link: "https://example.com/a", params: [:])
        surface.requestOpenLink(source: surface.view, link: "http://127.0.0.1:5173/app", params: [:])
        surface.requestOpenLink(source: surface.view, link: "file:///tmp/private", params: [:])
        surface.requestOpenLink(source: surface.view, link: "not a URL", params: [:])

        XCTAssertEqual(opener.openedURLs, [
            URL(string: "https://example.com/a")!,
            URL(string: "http://127.0.0.1:5173/app")!,
        ])
        surface.destroy()
    }
}
