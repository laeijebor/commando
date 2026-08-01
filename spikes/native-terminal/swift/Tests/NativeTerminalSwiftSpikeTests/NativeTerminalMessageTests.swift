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
