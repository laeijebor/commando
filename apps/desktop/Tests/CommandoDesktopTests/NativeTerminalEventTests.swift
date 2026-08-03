import XCTest
@testable import CommandoDesktop

final class NativeTerminalEventTests: XCTestCase {
    private let identity = PaneIdentity(paneId: "%7", attachmentId: "page-id:4")

    func testEveryEventUsesTheReactEnvelopeAndPayloadContract() throws {
        let capabilities = NativeTerminalProtocol.requiredCapabilities + ["terminal.metal"]
        let events: [(String, [String: Any], Set<String>)] = [
            (
                "bridge.connected",
                NativeTerminalEventBuilder.bridgeConnected(capabilities: capabilities, maxPanes: 64),
                ["capabilities", "maxPanes"]
            ),
            (
                "bridge.rejected",
                NativeTerminalEventBuilder.bridgeRejected(reason: "unsupported_version"),
                ["reason"]
            ),
            ("pane.attached", NativeTerminalEventBuilder.paneIdentity(identity), ["paneId", "attachmentId"]),
            (
                "pane.seeded",
                NativeTerminalEventBuilder.paneSeeded(identity, revision: 8),
                ["paneId", "attachmentId", "revision"]
            ),
            (
                "pane.input_bytes",
                NativeTerminalEventBuilder.paneInput(identity, data: Data([0, 0xff, 0x80])),
                ["paneId", "attachmentId", "data"]
            ),
            (
                "pane.resize",
                NativeTerminalEventBuilder.paneResize(identity, size: .init(cols: 90, rows: 30)),
                ["paneId", "attachmentId", "cols", "rows"]
            ),
            (
                "pane.focus_changed",
                NativeTerminalEventBuilder.paneFocusChanged(identity, focused: true),
                ["paneId", "attachmentId", "focused"]
            ),
            ("pane.detached", NativeTerminalEventBuilder.paneIdentity(identity), ["paneId", "attachmentId"]),
            (
                "pane.failed",
                NativeTerminalEventBuilder.paneFailed(identity, code: "max_panes", fatal: false),
                ["paneId", "attachmentId", "code", "fatal"]
            ),
            (
                "host.shortcut",
                NativeTerminalEventBuilder.hostShortcut(key: "k"),
                ["key", "metaKey"]
            ),
        ]

        for (index, event) in events.enumerated() {
            let serialized = try roundTrip(NativeTerminalEventBuilder.envelope(
                pageId: "page-id",
                eventSequence: index + 1,
                type: event.0,
                payload: event.1
            ))
            XCTAssertEqual(Set(serialized.keys), [
                "version", "pageId", "eventSequence", "type", "payload",
            ])
            XCTAssertEqual(serialized["version"] as? Int, 1)
            XCTAssertEqual(serialized["pageId"] as? String, "page-id")
            XCTAssertEqual(serialized["eventSequence"] as? Int, index + 1)
            XCTAssertEqual(serialized["type"] as? String, event.0)
            let payload = try XCTUnwrap(serialized["payload"] as? [String: Any])
            XCTAssertEqual(Set(payload.keys), event.2, "Unexpected fields for \(event.0)")
        }
    }

    func testReportedMismatchPayloadsSerializeExactlyAsReactAccepts() throws {
        let rejection = try roundTripPayload(
            NativeTerminalEventBuilder.bridgeRejected(reason: "invalid_protocol")
        )
        XCTAssertEqual(rejection.count, 1)
        XCTAssertEqual(rejection["reason"] as? String, "invalid_protocol")

        let failure = try roundTripPayload(
            NativeTerminalEventBuilder.paneFailed(identity, code: "max_panes", fatal: false)
        )
        XCTAssertEqual(Set(failure.keys), ["paneId", "attachmentId", "code", "fatal"])
        XCTAssertEqual(failure["paneId"] as? String, "%7")
        XCTAssertEqual(failure["attachmentId"] as? String, "page-id:4")
        XCTAssertEqual(failure["code"] as? String, "max_panes")
        XCTAssertEqual(failure["fatal"] as? Bool, false)

        for key in ["k", "1", "9"] {
            let shortcut = try roundTripPayload(NativeTerminalEventBuilder.hostShortcut(key: key))
            XCTAssertEqual(Set(shortcut.keys), ["key", "metaKey"])
            XCTAssertEqual(shortcut["key"] as? String, key)
            XCTAssertEqual(shortcut["metaKey"] as? Bool, true)
        }
    }

    func testOtherPayloadFieldTypesMatchReactValidation() throws {
        let connected = try roundTripPayload(NativeTerminalEventBuilder.bridgeConnected(
            capabilities: NativeTerminalProtocol.requiredCapabilities,
            maxPanes: 64
        ))
        XCTAssertEqual(connected["capabilities"] as? [String], NativeTerminalProtocol.requiredCapabilities)
        XCTAssertEqual(connected["maxPanes"] as? Int, 64)

        let input = try roundTripPayload(
            NativeTerminalEventBuilder.paneInput(identity, data: Data([0, 0xff, 0x80]))
        )
        XCTAssertEqual(input["data"] as? String, "AP+A")

        let resize = try roundTripPayload(
            NativeTerminalEventBuilder.paneResize(identity, size: .init(cols: 90, rows: 30))
        )
        XCTAssertEqual(resize["cols"] as? Int, 90)
        XCTAssertEqual(resize["rows"] as? Int, 30)

        let focus = try roundTripPayload(
            NativeTerminalEventBuilder.paneFocusChanged(identity, focused: true)
        )
        XCTAssertEqual(focus["focused"] as? Bool, true)
    }

    private func roundTripPayload(_ payload: [String: Any]) throws -> [String: Any] {
        try roundTrip(["payload": payload])["payload"] as? [String: Any] ?? [:]
    }

    private func roundTrip(_ object: [String: Any]) throws -> [String: Any] {
        XCTAssertTrue(JSONSerialization.isValidJSONObject(object))
        let data = try JSONSerialization.data(withJSONObject: object)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
    }
}
