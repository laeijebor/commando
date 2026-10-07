import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class NativeTerminalBridgeLifecycleTests: XCTestCase {
    func testPageReplacementConnectsBeforeAnyNewPageSurfaceEvent() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))

        var events: [[String: Any]] = []
        let bridge = NativeTerminalBridge(
            webView: nil,
            overlay: overlay,
            prefersMetal: false,
            eventObserver: { events.append($0) }
        )
        let oldPage = "old-page"
        let newPage = "new-page"
        let identity = PaneIdentity(paneId: "%1", attachmentId: "old-page:1")

        bridge.receiveNativeTerminalMessage(body: message(
            pageId: oldPage,
            sequence: 1,
            type: "bridge.connect",
            payload: ["supportedVersions": [1]]
        ))
        bridge.receiveSurfaceEvent(identity: identity, event: .focusChanged(true))
        XCTAssertTrue(events.contains(where: {
            $0["pageId"] as? String == oldPage && $0["type"] as? String == "pane.focus_changed"
        }))
        let eventCountBeforeTeardown = events.count
        bridge.withoutSurfaceEvents {
            bridge.receiveSurfaceEvent(identity: identity, event: .focusChanged(false))
        }
        XCTAssertEqual(events.count, eventCountBeforeTeardown)

        bridge.receiveNativeTerminalMessage(body: message(
            pageId: newPage,
            sequence: 1,
            type: "bridge.connect",
            payload: ["supportedVersions": [1]]
        ))

        let newPageEvents = events.filter { $0["pageId"] as? String == newPage }
        XCTAssertEqual(newPageEvents.count, 1)
        XCTAssertEqual(newPageEvents[0]["type"] as? String, "bridge.connected")
        XCTAssertEqual(newPageEvents[0]["eventSequence"] as? Int, 1)
        XCTAssertFalse(newPageEvents.contains(where: { $0["type"] as? String == "pane.focus_changed" }))

        bridge.cleanUp()
    }

    func testThemeMessageUpdatesTheTerminalPalette() {
        defer { TerminalProfile.palette = .rosePineMoon }
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        var events: [[String: Any]] = []
        let bridge = NativeTerminalBridge(
            webView: nil,
            overlay: overlay,
            prefersMetal: false,
            eventObserver: { events.append($0) }
        )

        bridge.receiveNativeTerminalMessage(body: message(
            pageId: "page",
            sequence: 1,
            type: "bridge.connect",
            payload: ["supportedVersions": [1]]
        ))
        bridge.receiveNativeTerminalMessage(body: message(
            pageId: "page",
            sequence: 2,
            type: "bridge.theme",
            payload: [
                "background": "#181818",
                "foreground": "#d6d6d6",
                "cursor": "#e4e4e4",
                "cursorText": "#181818",
                "selectionBackground": "#264f78",
                "selectionForeground": "#ffffff",
                "ansi": Array(repeating: "#808080", count: 16),
            ]
        ))

        XCTAssertFalse(events.contains(where: { $0["type"] as? String == "bridge.rejected" }))
        XCTAssertEqual(TerminalProfile.palette.background, 0x181818)
        XCTAssertEqual(TerminalProfile.palette.ansi, Array(repeating: 0x808080, count: 16))
        bridge.cleanUp()
    }

    private func message(
        pageId: String,
        sequence: Int,
        type: String,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "protocol": NativeTerminalProtocol.name,
            "version": NativeTerminalProtocol.version,
            "pageId": pageId,
            "sequence": sequence,
            "type": type,
            "payload": payload,
        ]
    }
}
