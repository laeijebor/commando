import XCTest
@testable import CommandoDesktop

final class NativeTerminalProtocolTests: XCTestCase {
    func testDecodesConnectAndAllPaneCommands() throws {
        XCTAssertEqual(
            try decode("bridge.connect", payload: ["supportedVersions": [1]]).command,
            .connect(.init(supportedVersions: [1]))
        )

        let identity = PaneIdentity(paneId: "%12", attachmentId: "attachment-1")
        XCTAssertEqual(
            try decode("pane.attach", payload: identityPayload(identity).merging([
                "ariaLabel": "Terminal 12",
            ]) { _, new in new }).command,
            .attach(.init(identity: identity, ariaLabel: "Terminal 12"))
        )
        XCTAssertEqual(
            try decode("pane.focus", payload: identityPayload(identity)).command,
            .focus(identity)
        )
        XCTAssertEqual(
            try decode("pane.detach", payload: identityPayload(identity)).command,
            .detach(identity)
        )

        let frame = try decode("pane.frame", payload: identityPayload(identity).merging([
            "x": -12.5,
            "y": 20,
            "width": 800,
            "height": 400,
            "scale": 2,
            "visible": true,
            "resizeOwner": false,
            "order": 3,
        ]) { _, new in new })
        XCTAssertEqual(
            frame.command,
            .frame(.init(
                identity: identity,
                x: -12.5,
                y: 20,
                width: 800,
                height: 400,
                scale: 2,
                visible: true,
                resizeOwner: false,
                order: 3
            ))
        )

        let bytes = Data([0, 0xff, 0x41])
        XCTAssertEqual(
            try decode("pane.reset", payload: identityPayload(identity).merging([
                "data": bytes.base64EncodedString(),
                "cols": 120,
                "rows": 40,
                "revision": 7,
            ]) { _, new in new }).command,
            .reset(.init(identity: identity, data: bytes, cols: 120, rows: 40, revision: 7))
        )
        XCTAssertEqual(
            try decode("pane.data", payload: identityPayload(identity).merging([
                "data": bytes.base64EncodedString(),
                "revision": 8,
            ]) { _, new in new }).command,
            .data(.init(identity: identity, data: bytes, revision: 8))
        )
    }

    func testRejectsWrongProtocolVersionAndUnexpectedFields() {
        var message = envelope("bridge.connect", payload: ["supportedVersions": [1]])
        message["protocol"] = "other"
        assertError(message, code: "invalid_protocol")

        message = envelope("bridge.connect", payload: ["supportedVersions": [1]])
        message["version"] = 2
        assertError(message, code: "unsupported_version")

        message = envelope("bridge.connect", payload: ["supportedVersions": [1]])
        message["extra"] = true
        assertError(message, code: "invalid_payload")

        assertError(
            envelope("pane.focus", payload: [
                "paneId": "%1",
                "attachmentId": "a",
                "extra": true,
            ]),
            code: "invalid_payload"
        )
    }

    func testRejectsMalformedIdentifiersAndLabels() {
        for paneId in ["", "%", "1", "%one", "%1;kill-server"] {
            assertError(
                envelope("pane.focus", payload: ["paneId": paneId, "attachmentId": "a"]),
                code: "invalid_id"
            )
        }
        for attachmentId in ["", "contains space", "line\nbreak"] {
            assertError(
                envelope("pane.focus", payload: ["paneId": "%1", "attachmentId": attachmentId]),
                code: "invalid_id"
            )
        }
        assertError(
            envelope("pane.attach", payload: [
                "paneId": "%1",
                "attachmentId": "a",
                "ariaLabel": "",
            ]),
            code: "invalid_payload"
        )
    }

    func testCanonicalBase64PreservesArbitraryBytesAndEnforcesDataLimit() throws {
        let bytes = Data([0x00, 0xff, 0x80, 0x41])
        let command = try decode("pane.data", payload: [
            "paneId": "%1",
            "attachmentId": "a",
            "data": bytes.base64EncodedString(),
            "revision": 1,
        ]).command
        XCTAssertEqual(command, .data(.init(
            identity: .init(paneId: "%1", attachmentId: "a"),
            data: bytes,
            revision: 1
        )))

        for invalid in ["not base64", "AQ", "AB==", "AA==\n"] {
            assertError(
                envelope("pane.data", payload: [
                    "paneId": "%1",
                    "attachmentId": "a",
                    "data": invalid,
                    "revision": 1,
                ]),
                code: "invalid_data"
            )
        }

        let oversized = Data(repeating: 0, count: NativeTerminalProtocol.maxDataBytes + 1)
        assertError(
            envelope("pane.data", payload: [
                "paneId": "%1",
                "attachmentId": "a",
                "data": oversized.base64EncodedString(),
                "revision": 1,
            ]),
            code: "invalid_data"
        )

        let oversizedReset = Data(repeating: 0, count: NativeTerminalProtocol.maxResetBytes + 1)
        assertError(
            envelope("pane.reset", payload: [
                "paneId": "%1",
                "attachmentId": "a",
                "data": oversizedReset.base64EncodedString(),
                "cols": 80,
                "rows": 24,
                "revision": 1,
            ]),
            code: "invalid_data"
        )
    }

    func testRejectsInvalidGeometryGridSequenceAndRevision() {
        let identity: [String: Any] = ["paneId": "%1", "attachmentId": "a"]
        for invalidGeometry: [String: Any] in [
            ["x": 0, "y": 0, "width": -1, "height": 1, "scale": 1],
            ["x": 0, "y": 0, "width": 1, "height": -1, "scale": 1],
            ["x": 0, "y": 0, "width": 1, "height": 1, "scale": 0],
            ["x": Double.infinity, "y": 0, "width": 1, "height": 1, "scale": 1],
        ] {
            assertError(
                envelope("pane.frame", payload: identity.merging(invalidGeometry.merging([
                    "visible": true,
                    "resizeOwner": true,
                    "order": 0,
                ]) { _, new in new }) { _, new in new }),
                code: invalidGeometry["x"] as? Double == Double.infinity
                    ? "invalid_payload"
                    : "invalid_geometry"
            )
        }

        for (cols, rows) in [(1, 24), (501, 24), (80, 0), (80, 201)] {
            assertError(
                envelope("pane.reset", payload: identity.merging([
                    "data": "",
                    "cols": cols,
                    "rows": rows,
                    "revision": 0,
                ]) { _, new in new }),
                code: "invalid_grid"
            )
        }

        var invalidSequence = envelope("bridge.connect", payload: ["supportedVersions": [1]])
        invalidSequence["sequence"] = -1
        assertError(invalidSequence, code: "invalid_payload")
        invalidSequence["sequence"] = Double(NativeTerminalProtocol.maxSafeInteger) + 2
        assertError(invalidSequence, code: "invalid_payload")

        for revision: Any in [-1, 1.5, Double(NativeTerminalProtocol.maxSafeInteger) + 2] {
            assertError(
                envelope("pane.data", payload: identity.merging([
                    "data": "",
                    "revision": revision,
                ]) { _, new in new }),
                code: "invalid_payload"
            )
        }
    }

    private func decode(
        _ type: String,
        payload: [String: Any],
        pageId: String = "page-1",
        sequence: Int = 0
    ) throws -> NativeTerminalEnvelope {
        try NativeTerminalEnvelope.decode(jsonObject: envelope(
            type,
            payload: payload,
            pageId: pageId,
            sequence: sequence
        ))
    }

    private func envelope(
        _ type: String,
        payload: [String: Any],
        pageId: String = "page-1",
        sequence: Int = 0
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

    private func identityPayload(_ identity: PaneIdentity) -> [String: Any] {
        ["paneId": identity.paneId, "attachmentId": identity.attachmentId]
    }

    private func assertError(
        _ object: Any,
        code: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try NativeTerminalEnvelope.decode(jsonObject: object),
            file: file,
            line: line
        ) { error in
            XCTAssertEqual((error as? ProtocolValidationError)?.code, code, file: file, line: line)
        }
    }
}
