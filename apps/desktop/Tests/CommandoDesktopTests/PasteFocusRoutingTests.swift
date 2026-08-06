import AppKit
import XCTest

@testable import CommandoDesktop

@MainActor
final class PasteFocusRoutingTests: XCTestCase {
    func testCommandVRoutesPasteToFocusedPane() throws {
        let pasteboard = NSPasteboard(name: .init("PasteRoutingRepro.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("clipboard-text", forType: .string)
        defer { pasteboard.clearContents() }

        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        let window = NSWindow(
            contentRect: overlay.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = overlay

        var pastes: [(paneId: String, text: String)] = []
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            pasteboard: pasteboard
        ) { identity, event in
            if case let .paste(text) = event {
                pastes.append((identity.paneId, text))
            }
        }

        let paneA = PaneIdentity(paneId: "%1", attachmentId: "pane-a")
        let paneB = PaneIdentity(paneId: "%2", attachmentId: "pane-b")
        host.attach(.init(identity: paneA, ariaLabel: "Terminal A"))
        host.attach(.init(identity: paneB, ariaLabel: "Terminal B"))
        XCTAssertTrue(host.applyFrame(.init(
            identity: paneA,
            x: 10, y: 10, width: 400, height: 300,
            scale: 1, visible: true,
            visibleRegions: [.init(x: 10, y: 10, width: 400, height: 300)],
            resizeOwner: true, order: 0
        )))
        XCTAssertTrue(host.applyFrame(.init(
            identity: paneB,
            x: 460, y: 10, width: 400, height: 300,
            scale: 1, visible: true,
            visibleRegions: [.init(x: 460, y: 10, width: 400, height: 300)],
            resizeOwner: true, order: 1
        )))

        // Focus pane B, then dispatch Cmd+V the way NSWindow does: down the
        // view hierarchy from the content view, not via the first responder.
        XCTAssertTrue(host.focus(paneB))
        let surfaceB = try XCTUnwrap(host.registry.record(for: paneB)?.value)
        XCTAssertTrue(window.firstResponder === surfaceB.view)

        let commandV = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))
        XCTAssertTrue(overlay.performKeyEquivalent(with: commandV))

        XCTAssertEqual(pastes.map(\.paneId), ["%2"], "paste should land in the focused pane")

        host.destroyAll()
        window.contentView = nil
        window.orderOut(nil)
    }
}
