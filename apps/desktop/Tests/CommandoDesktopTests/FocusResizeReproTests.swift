import AppKit
import XCTest

@testable import CommandoDesktop

/// Reproduces the focus/app-switch resize bug: a pane that was reseeded to a
/// smaller source grid while another client held resize authority must refit
/// to its viewport when it regains ownership, even though its view frame is
/// unchanged.
@MainActor
final class FocusResizeReproTests: XCTestCase {
    func testRegainingOwnershipRefitsStaleSourceGridWhenFrameIsUnchanged() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 900, height: 800))
        let window = NSWindow(
            contentRect: overlay.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = overlay
        var resizeEvents: [GridSize] = []
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false
        ) { _, event in
            if case let .resize(size) = event { resizeEvents.append(size) }
        }
        let identity = PaneIdentity(paneId: "%1", attachmentId: "focus-repro")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))

        // 1. Active window: the pane owns resizes and fits its viewport.
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 478.5,
            height: 603,
            visible: true,
            resizeOwner: true
        )))
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        let ownerGrid = GridSize(
            cols: surface.view.getTerminal().cols,
            rows: surface.view.getTerminal().rows
        )
        let ownerFrame = surface.view.frame

        // 2. App deactivates: ownership released.
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 478.5,
            height: 603,
            visible: true,
            resizeOwner: false
        )))

        // 3. Another (smaller) client resizes tmux; the daemon reseeds this pane.
        XCTAssertTrue(host.applyReset(.init(
            identity: identity,
            data: Data("smaller client".utf8),
            cols: 40,
            rows: 12,
            revision: 1
        )))
        XCTAssertEqual(
            GridSize(cols: surface.view.getTerminal().cols, rows: surface.view.getTerminal().rows),
            GridSize(cols: 40, rows: 12)
        )
        // The non-owner frame should still cover the viewport (letterboxed content).
        XCTAssertEqual(surface.view.frame, ownerFrame)
        resizeEvents.removeAll()

        // 4. App reactivates: pane becomes resize owner again with an unchanged frame.
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 478.5,
            height: 603,
            visible: true,
            resizeOwner: true
        )))

        let finalGrid = GridSize(
            cols: surface.view.getTerminal().cols,
            rows: surface.view.getTerminal().rows
        )
        XCTAssertEqual(finalGrid, ownerGrid, "owner must refit its viewport after regaining ownership")
        XCTAssertEqual(resizeEvents.last, ownerGrid, "the emitted resize must be the refit grid, not the stale seed")
        XCTAssertFalse(resizeEvents.contains(GridSize(cols: 40, rows: 12)),
                       "the stale non-owner grid must never be echoed to the web layer as a measured capacity")

        host.destroyAll()
        window.contentView = nil
        window.orderOut(nil)
    }

    private func frame(
        identity: PaneIdentity,
        x: Double = 10,
        width: Double = 400,
        height: Double = 300,
        visible: Bool,
        resizeOwner: Bool,
        order: Int = 0,
        scale: Double = 1
    ) -> PaneFramePayload {
        .init(
            identity: identity,
            x: x,
            y: 10,
            width: width,
            height: height,
            scale: scale,
            visible: visible,
            visibleRegions: [
                .init(x: x, y: 10, width: width, height: height),
            ],
            resizeOwner: resizeOwner,
            order: order
        )
    }
}
