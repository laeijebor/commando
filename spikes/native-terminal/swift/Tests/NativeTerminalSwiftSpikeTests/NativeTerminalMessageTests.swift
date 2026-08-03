import XCTest
@testable import NativeTerminalSwiftSpike

final class NativeTerminalMessageTests: XCTestCase {
    func testDecodesFrameMessage() throws {
        let message = try NativeTerminalMessage.decode(jsonObject: [
            "kind": "frame",
            "x": 101.5,
            "y": 72,
            "width": 640,
            "height": 330,
            "visible": true,
            "scale": 2,
        ])

        XCTAssertEqual(
            message,
            .frame(
                TerminalFramePayload(
                    x: 101.5,
                    y: 72,
                    width: 640,
                    height: 330,
                    visible: true,
                    scale: 2
                )
            )
        )
    }

    func testDecodesFocusMessage() throws {
        let message = try NativeTerminalMessage.decode(jsonObject: ["kind": "focus"])

        XCTAssertEqual(message, .focus)
    }

    func testDecodesResetWithRawBytesAndIgnoresExtraTerminalState() throws {
        let bytes = Data([0x00, 0xff, 0x80, 0x41])
        let message = try NativeTerminalMessage.decode(jsonObject: [
            "kind": "reset",
            "paneId": "%12",
            "data": bytes.base64EncodedString(),
            "cols": 120,
            "rows": 40,
            "revision": 7,
            "terminalState": ["cursorShape": "block"],
        ])

        XCTAssertEqual(
            message,
            .reset(
                TerminalResetPayload(
                    paneId: "%12",
                    data: bytes,
                    cols: 120,
                    rows: 40,
                    revision: 7
                )
            )
        )
    }

    func testDecodesDataWithRawBytes() throws {
        let bytes = Data([0xf0, 0x00, 0xfe, 0x7f])
        let message = try NativeTerminalMessage.decode(jsonObject: [
            "kind": "data",
            "paneId": "%2",
            "data": bytes.base64EncodedString(),
            "revision": 8,
        ])

        XCTAssertEqual(
            message,
            .data(TerminalDataPayload(paneId: "%2", data: bytes, revision: 8))
        )
    }

    func testRejectsInvalidBase64() {
        for encoded in ["not base64", "AQ", "AB=="] {
            XCTAssertThrowsError(
                try NativeTerminalMessage.decode(jsonObject: [
                    "kind": "data",
                    "paneId": "%1",
                    "data": encoded,
                    "revision": 1,
                ]),
                "Expected strict base64 decoding to reject \(encoded)"
            )
        }
    }

    func testRejectsInvalidPaneIds() {
        for paneId in ["", "%", "1", "%1;kill-server", "%one"] {
            XCTAssertThrowsError(
                try NativeTerminalMessage.decode(jsonObject: [
                    "kind": "data",
                    "paneId": paneId,
                    "data": "",
                    "revision": 1,
                ]),
                "Expected pane ID validation to reject \(paneId)"
            )
        }
    }

    func testRejectsInvalidGridDimensions() {
        let invalidGrids = [
            (NativeTerminalMessage.minCols - 1, 40),
            (NativeTerminalMessage.maxCols + 1, 40),
            (120, NativeTerminalMessage.minRows - 1),
            (120, NativeTerminalMessage.maxRows + 1),
        ]

        for (cols, rows) in invalidGrids {
            XCTAssertThrowsError(
                try NativeTerminalMessage.decode(jsonObject: [
                    "kind": "reset",
                    "paneId": "%1",
                    "data": "",
                    "cols": cols,
                    "rows": rows,
                    "revision": 1,
                ]),
                "Expected grid validation to reject \(cols)x\(rows)"
            )
        }
    }

    func testRejectsInvalidRevisions() {
        for revision: Any in [-1, NativeTerminalMessage.maxSafeRevision + 1, 1.5] {
            XCTAssertThrowsError(
                try NativeTerminalMessage.decode(jsonObject: [
                    "kind": "data",
                    "paneId": "%1",
                    "data": "",
                    "revision": revision,
                ]),
                "Expected revision validation to reject \(revision)"
            )
        }
    }

    func testOrderGateRejectsStaleAndMismatchedData() {
        var gate = NativeTerminalOrderGate()
        let reset = TerminalResetPayload(
            paneId: "%1",
            data: Data(),
            cols: 80,
            rows: 24,
            revision: 5
        )

        XCTAssertTrue(gate.accept(reset: reset))
        XCTAssertFalse(
            gate.accept(data: TerminalDataPayload(paneId: "%1", data: Data(), revision: 5))
        )
        XCTAssertFalse(
            gate.accept(data: TerminalDataPayload(paneId: "%2", data: Data(), revision: 6))
        )
        XCTAssertTrue(
            gate.accept(data: TerminalDataPayload(paneId: "%1", data: Data(), revision: 6))
        )
        XCTAssertFalse(
            gate.accept(data: TerminalDataPayload(paneId: "%1", data: Data(), revision: 4))
        )
        XCTAssertEqual(gate.paneId, "%1")
        XCTAssertEqual(gate.revision, 6)
    }

    func testOrderGateTreatsResetAsAuthoritativeAndRebasesRevision() {
        var gate = NativeTerminalOrderGate()
        let first = TerminalResetPayload(
            paneId: "%1",
            data: Data(),
            cols: 80,
            rows: 24,
            revision: 9
        )
        let reconnect = TerminalResetPayload(
            paneId: "%2",
            data: Data(),
            cols: 120,
            rows: 40,
            revision: 1
        )

        XCTAssertTrue(gate.accept(reset: first))
        XCTAssertTrue(gate.accept(reset: reconnect))
        XCTAssertFalse(
            gate.accept(data: TerminalDataPayload(paneId: "%1", data: Data(), revision: 10))
        )
        XCTAssertTrue(
            gate.accept(data: TerminalDataPayload(paneId: "%2", data: Data(), revision: 2))
        )
        XCTAssertEqual(gate.paneId, "%2")
        XCTAssertEqual(gate.revision, 2)
    }

    func testRejectsInvalidFrameScale() {
        XCTAssertThrowsError(
            try NativeTerminalMessage.decode(jsonObject: [
                "kind": "frame",
                "x": 0,
                "y": 0,
                "width": 100,
                "height": 100,
                "visible": true,
                "scale": 0,
            ])
        )
    }
}
