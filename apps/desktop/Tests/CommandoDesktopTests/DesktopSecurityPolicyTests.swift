import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class DesktopSecurityPolicyTests: XCTestCase {
    func testOSC52ClipboardPolicyDeniesReadsAndWritesByDefault() {
        let pasteboard = NSPasteboard(name: .init("CommandoDesktopTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("private clipboard", forType: .string)

        let policy = TerminalClipboardPolicy.defaultDeny
        XCTAssertNil(policy.read(from: pasteboard))
        policy.write(Data("attacker controlled".utf8), to: pasteboard)
        XCTAssertEqual(pasteboard.string(forType: .string), "private clipboard")
        pasteboard.clearContents()
    }

    func testRendererVisibilityPolicyDisablesAndRestoresMetal() {
        XCTAssertEqual(
            TerminalRendererVisibilityPolicy.action(
                isHidden: true,
                prefersMetal: true,
                isUsingMetal: true
            ),
            .disableMetal
        )
        XCTAssertEqual(
            TerminalRendererVisibilityPolicy.action(
                isHidden: false,
                prefersMetal: true,
                isUsingMetal: false
            ),
            .enableMetalAndRedraw
        )
        XCTAssertEqual(
            TerminalRendererVisibilityPolicy.action(
                isHidden: false,
                prefersMetal: false,
                isUsingMetal: false
            ),
            .redraw
        )
    }

    func testOnlyHidingTheFocusedSurfaceTransfersFocusToWebFallback() {
        XCTAssertTrue(TerminalFocusTransferPolicy.shouldTransfer(wasFocused: true, isHidden: true))
        XCTAssertFalse(TerminalFocusTransferPolicy.shouldTransfer(wasFocused: false, isHidden: true))
        XCTAssertFalse(TerminalFocusTransferPolicy.shouldTransfer(wasFocused: true, isHidden: false))
    }

    func testConnectionStatusReturnsForRetryAndExplainsExternalService() {
        let view = ConnectionStatusView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let origin = WebOrigin(url: URL(string: "http://127.0.0.1:4310")!)!

        view.show(.connecting, origin: origin)
        XCTAssertFalse(view.isHidden)
        XCTAssertEqual(view.state, .connecting)
        XCTAssertTrue(view.statusText.contains("external Commando service"))

        view.hide()
        XCTAssertTrue(view.isHidden)
        XCTAssertNil(view.state)

        view.show(.retrying, origin: origin)
        XCTAssertEqual(view.state, .retrying)
        XCTAssertTrue(view.statusText.contains("Retrying"))
        XCTAssertTrue(view.statusText.contains("127.0.0.1:4310"))
    }
}
