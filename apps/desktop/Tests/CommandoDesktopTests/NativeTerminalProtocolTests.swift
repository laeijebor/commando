import XCTest
@testable import CommandoDesktop

final class NativeTerminalProtocolTests: XCTestCase {
    func testRequiredCapabilitiesCoverEveryVersionOneAction() {
        XCTAssertTrue(NativeTerminalProtocol.requiredCapabilities.contains("terminal.metadataUpdates.v1"))
        XCTAssertTrue(NativeTerminalProtocol.requiredCapabilities.contains("terminal.pasteText.v1"))
        XCTAssertTrue(NativeTerminalProtocol.requiredCapabilities.contains("terminal.selectionCopy.v1"))
        XCTAssertTrue(NativeTerminalProtocol.requiredCapabilities.contains("terminal.contextMenu.v1"))
        XCTAssertTrue(NativeTerminalProtocol.requiredCapabilities.contains("terminal.accessibilityValue.v1"))
    }

    func testDecodesConnectAndAllPaneCommands() throws {
        XCTAssertEqual(
            try decode("bridge.connect", payload: ["supportedVersions": [1]]).command,
            .connect(.init(supportedVersions: [1]))
        )

        let identity = PaneIdentity(paneId: "%12", attachmentId: "attachment-1")
        XCTAssertEqual(
            try decode("pane.attach", payload: identityPayload(identity).merging([
                "ariaLabel": "Terminal 12",
                "accessibilityEnabled": true,
                "keyShortcuts": ["Meta+C", "Meta+V", "PageUp", "PageDown"],
            ]) { _, new in new }).command,
            .attach(.init(
                identity: identity,
                ariaLabel: "Terminal 12",
                accessibilityEnabled: true,
                keyShortcuts: ["Meta+C", "Meta+V", "PageUp", "PageDown"]
            ))
        )
        XCTAssertEqual(
            try decode("pane.update", payload: identityPayload(identity).merging([
                "ariaLabel": "Terminal 12, disconnected",
                "accessibilityEnabled": false,
                "keyShortcuts": ["Meta+C", "Meta+V", "PageUp", "PageDown"],
            ]) { _, new in new }).command,
            .update(.init(
                identity: identity,
                metadata: .init(
                    ariaLabel: "Terminal 12, disconnected",
                    accessibilityEnabled: false,
                    keyShortcuts: ["Meta+C", "Meta+V", "PageUp", "PageDown"]
                )
            ))
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
            "visibleRegions": [["x": 10, "y": 20, "width": 800, "height": 400]],
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
                visibleRegions: [.init(x: 10, y: 20, width: 800, height: 400)],
                resizeOwner: false,
                order: 3
            ))
        )

        let hitRegionFrame = try decode("pane.frame", payload: identityPayload(identity).merging([
            "x": 0,
            "y": 0,
            "width": 800,
            "height": 400,
            "scale": 2,
            "visible": true,
            "visibleRegions": [["x": 10, "y": 20, "width": 800, "height": 400]],
            "hitRegions": [["x": 10, "y": 20, "width": 100, "height": 50]],
            "resizeOwner": false,
            "order": 3,
        ]) { _, new in new })
        guard case let .frame(hitRegionPayload) = hitRegionFrame.command else {
            return XCTFail("Expected a frame command")
        }
        XCTAssertEqual(hitRegionPayload.visibleRegions, [.init(x: 10, y: 20, width: 800, height: 400)])
        XCTAssertEqual(hitRegionPayload.hitRegions, [.init(x: 10, y: 20, width: 100, height: 50)])
        guard case let .frame(defaultedPayload) = frame.command else {
            return XCTFail("Expected a frame command")
        }
        XCTAssertEqual(defaultedPayload.hitRegions, defaultedPayload.visibleRegions)

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
                "accessibilityEnabled": true,
                "keyShortcuts": ["Meta+C"],
            ]),
            code: "invalid_payload"
        )
        for keyShortcuts: [Any] in [[], ["Meta+C", "Meta+C"], ["bad\nshortcut"]] {
            assertError(
                envelope("pane.update", payload: [
                    "paneId": "%1",
                    "attachmentId": "a",
                    "ariaLabel": "Terminal",
                    "accessibilityEnabled": true,
                    "keyShortcuts": keyShortcuts,
                ]),
                code: "invalid_payload"
            )
        }
    }

    func testRecoversValidAttachmentIdentityFromRejectedPayload() {
        let valid = envelope("pane.focus", payload: [
            "paneId": "%1",
            "attachmentId": "attachment-1",
            "extra": true,
        ])
        XCTAssertEqual(
            NativeTerminalEnvelope.recoverableIdentity(from: valid),
            PaneIdentity(paneId: "%1", attachmentId: "attachment-1")
        )
        XCTAssertNil(NativeTerminalEnvelope.recoverableIdentity(from: envelope(
            "pane.focus",
            payload: ["paneId": "%bad", "attachmentId": "attachment-1"]
        )))
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
            ["x": Double.greatestFiniteMagnitude, "y": 0, "width": 1, "height": 1, "scale": 1],
            ["x": 0, "y": 0, "width": Double.greatestFiniteMagnitude, "height": 1, "scale": 1],
            ["x": 0, "y": 0, "width": 1, "height": 1, "scale": 9],
        ] {
            assertError(
                envelope("pane.frame", payload: identity.merging(invalidGeometry.merging([
                    "visible": true,
                    "visibleRegions": [["x": 0, "y": 0, "width": 1, "height": 1]],
                    "resizeOwner": true,
                    "order": 0,
                ]) { _, new in new }) { _, new in new }),
                code: invalidGeometry["x"] as? Double == Double.infinity
                    ? "invalid_payload"
                    : "invalid_geometry"
            )
        }

        for (visibleRegions, code): (Any, String) in [
            ([["x": 0, "y": 0, "width": 0, "height": 1]], "invalid_geometry"),
            ([["x": 0, "y": 0, "width": 1, "height": -1]], "invalid_geometry"),
            ([["x": Double.greatestFiniteMagnitude, "y": 0, "width": 1, "height": 1]],
             "invalid_geometry"),
            ([["x": 0, "y": 0, "width": Double.greatestFiniteMagnitude, "height": 1]],
             "invalid_geometry"),
            (Array(repeating: ["x": 0, "y": 0, "width": 1, "height": 1],
                   count: NativeTerminalProtocol.maxVisibleRegions + 1), "invalid_payload"),
        ] {
            assertError(
                envelope("pane.frame", payload: identity.merging([
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 100,
                    "scale": 1,
                    "visible": true,
                    "visibleRegions": visibleRegions,
                    "resizeOwner": true,
                    "order": 0,
                ]) { _, new in new }),
                code: code
            )
        }

        for (hitRegions, code): (Any, String) in [
            ([["x": 0, "y": 0, "width": 0, "height": 1]], "invalid_geometry"),
            ("not-an-array", "invalid_payload"),
            (Array(repeating: ["x": 0, "y": 0, "width": 1, "height": 1],
                   count: NativeTerminalProtocol.maxVisibleRegions + 1), "invalid_payload"),
        ] {
            assertError(
                envelope("pane.frame", payload: identity.merging([
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 100,
                    "scale": 1,
                    "visible": true,
                    "visibleRegions": [["x": 0, "y": 0, "width": 1, "height": 1]],
                    "hitRegions": hitRegions,
                    "resizeOwner": true,
                    "order": 0,
                ]) { _, new in new }),
                code: code
            )
        }

        for (cols, rows) in [
            (1, 24),
            (NativeTerminalProtocol.maxCols + 1, 24),
            (80, 0),
            (80, NativeTerminalProtocol.maxRows + 1),
        ] {
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
