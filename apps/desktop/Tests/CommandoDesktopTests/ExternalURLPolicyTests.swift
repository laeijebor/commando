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
private final class ExternalURLFailureReporterSpy: ExternalURLOpenFailureReporting {
    private(set) var failedURLs: [URL] = []

    func reportFailure(opening url: URL) {
        failedURLs.append(url)
    }
}

@MainActor
final class ExternalURLPolicyTests: XCTestCase {
    private let origin = WebOrigin(url: URL(string: "http://127.0.0.1:5173/app")!)!

    func testOnlyNonPopupExactOriginNavigationStaysInPrivilegedWebView() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)

        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "http://127.0.0.1:5173/notes?selected=1#block"),
                source: .webNavigation(opensInNewWindow: false)
            ),
            .allowInWebView
        )
        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "http://127.0.0.1:5173/new"),
                source: .webNavigation(opensInNewWindow: true)
            ),
            .cancel
        )
    }

    func testUntrustedWebNavigationNeverOpensTheSystemBrowser() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)

        for value in [
            "https://example.com/docs",
            "http://localhost:4310/api",
            "http://127.0.0.1:4310/api",
        ] {
            XCTAssertEqual(
                policy.disposition(
                    for: URL(string: value),
                    source: .webNavigation(opensInNewWindow: true)
                ),
                .cancel,
                value
            )
        }
    }

    func testTrustedExternalAndSameOriginPopupLinksOpenExternally() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)
        let values = [
            "https://example.com/docs",
            "http://localhost:4310/api",
            "http://127.0.0.1:4310/api",
            "http://127.0.0.1:5173/new",
        ]

        for value in values {
            XCTAssertEqual(
                policy.disposition(
                    for: URL(string: value),
                    source: .trustedWebLink(opensInNewWindow: true)
                ),
                .openExternally,
                value
            )
        }
        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "http://127.0.0.1:5173/notes"),
                source: .trustedWebLink(opensInNewWindow: false)
            ),
            .allowInWebView
        )
    }

    func testRedirectsCredentialsAndUnsafeSchemesAreCanceled() {
        let policy = SecureExternalURLPolicy(privilegedOrigin: origin)

        XCTAssertEqual(
            policy.disposition(
                for: URL(string: "https://example.com/redirected"),
                source: .webNavigation(opensInNewWindow: false)
            ),
            .cancel
        )
        for value in [
            "javascript:alert(1)",
            "file:///tmp/private",
            "mailto:security@example.com",
            "http://user:password@127.0.0.1:5173/private",
        ] {
            XCTAssertEqual(
                policy.disposition(
                    for: URL(string: value),
                    source: .trustedWebLink(opensInNewWindow: true)
                ),
                .cancel,
                value
            )
        }
        XCTAssertEqual(
            policy.disposition(
                for: nil,
                source: .trustedWebLink(opensInNewWindow: true)
            ),
            .cancel
        )
    }

    func testSafeHandlerCallsInjectedOpenerOnlyForTrustedExternalDisposition() {
        let opener = SystemURLOpenerSpy()
        let reporter = ExternalURLFailureReporterSpy()
        let handler = SafeExternalURLHandler(
            privilegedOrigin: origin,
            opener: opener,
            failureReporter: reporter
        )
        let external = URL(string: "https://example.com")!

        XCTAssertEqual(
            handler.handle(external, source: .trustedWebLink(opensInNewWindow: false)),
            .openExternally
        )
        XCTAssertEqual(
            handler.handle(external, source: .webNavigation(opensInNewWindow: false)),
            .cancel
        )
        XCTAssertEqual(
            handler.handle(
                URL(string: "http://127.0.0.1:5173/app"),
                source: .webNavigation(opensInNewWindow: false)
            ),
            .allowInWebView
        )

        XCTAssertEqual(opener.openedURLs, [external])
        XCTAssertTrue(reporter.failedURLs.isEmpty)
    }

    func testOpenerFailureIsReported() {
        let opener = SystemURLOpenerSpy()
        opener.result = false
        let reporter = ExternalURLFailureReporterSpy()
        let handler = SafeExternalURLHandler(
            privilegedOrigin: origin,
            opener: opener,
            failureReporter: reporter
        )
        let url = URL(string: "https://example.com/failure")!

        XCTAssertEqual(
            handler.handle(url, source: .trustedWebLink(opensInNewWindow: false)),
            .openExternally
        )
        XCTAssertEqual(opener.openedURLs, [url])
        XCTAssertEqual(reporter.failedURLs, [url])
    }

    func testSwiftTermOSC8LinksUseSafeHandlerForExplicitHTTPAndHTTPSOnly() {
        let opener = SystemURLOpenerSpy()
        let reporter = ExternalURLFailureReporterSpy()
        let handler = SafeExternalURLHandler(
            privilegedOrigin: origin,
            opener: opener,
            failureReporter: reporter
        )
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
        XCTAssertTrue(reporter.failedURLs.isEmpty)
        surface.destroy()
    }

    func testTrustedLinkRequestRejectsMalformedAndOversizedMessages() {
        XCTAssertEqual(
            TrustedLinkRequest.decode([
                "url": "https://example.com",
                "opensInNewWindow": true,
            ]),
            TrustedLinkRequest(url: URL(string: "https://example.com")!, opensInNewWindow: true)
        )
        XCTAssertNil(TrustedLinkRequest.decode(["url": "https://example.com"]))
        XCTAssertNil(TrustedLinkRequest.decode([
            "url": "https://example.com",
            "opensInNewWindow": true,
            "extra": false,
        ]))
        XCTAssertNil(TrustedLinkRequest.decode([
            "url": "https://example.com/\(String(repeating: "a", count: 8_192))",
            "opensInNewWindow": true,
        ]))
    }
}
