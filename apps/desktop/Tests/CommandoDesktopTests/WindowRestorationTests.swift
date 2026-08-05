import AppKit
import XCTest
@testable import CommandoDesktop

final class WindowRestorationTests: XCTestCase {
    private let visibleFrame = NSRect(x: 0, y: 0, width: 1_920, height: 1_080)

    func testFrameSerializationRoundTripsWindowCountAndFrames() throws {
        let frames = [
            NSRect(x: 20, y: 30, width: 800, height: 600),
            NSRect(x: 400, y: 200, width: 1_000, height: 700),
        ]

        let data = try XCTUnwrap(WindowRestorationCodec.encode(frames: frames))
        let restored = WindowRestorationCodec.decode(data, visibleFrames: [visibleFrame])

        XCTAssertEqual(restored, frames)
    }

    func testSerializationBoundsTheRestoredWindowCount() throws {
        let frames = (0..<20).map { index in
            NSRect(x: CGFloat(index), y: CGFloat(index), width: 800, height: 600)
        }

        let data = try XCTUnwrap(WindowRestorationCodec.encode(frames: frames))
        let restored = WindowRestorationCodec.decode(data, visibleFrames: [visibleFrame])

        XCTAssertEqual(restored.count, WindowRestorationCodec.maximumWindowCount)
        XCTAssertEqual(restored, Array(frames.prefix(WindowRestorationCodec.maximumWindowCount)))
    }

    func testMalformedOversizedAndUnsupportedSnapshotsAreRejected() {
        let oversized = Data(repeating: 0x20, count: WindowRestorationCodec.maximumStoredBytes + 1)
        let unsupported = Data(#"{"version":2,"frames":[]}"#.utf8)

        XCTAssertEqual(
            WindowRestorationCodec.decode(Data("not-json".utf8), visibleFrames: [visibleFrame]),
            []
        )
        XCTAssertEqual(WindowRestorationCodec.decode(oversized, visibleFrames: [visibleFrame]), [])
        XCTAssertEqual(WindowRestorationCodec.decode(unsupported, visibleFrames: [visibleFrame]), [])
        XCTAssertEqual(WindowRestorationCodec.decode(nil, visibleFrames: [visibleFrame]), [])
    }

    func testOffscreenAndOversizedFramesAreConstrainedToAVisibleScreen() throws {
        let frames = [
            NSRect(x: 50_000, y: 50_000, width: 900, height: 700),
            NSRect(x: -500, y: -500, width: 9_000, height: 9_000),
        ]
        let data = try XCTUnwrap(WindowRestorationCodec.encode(frames: frames))

        let restored = WindowRestorationCodec.decode(data, visibleFrames: [visibleFrame])

        XCTAssertEqual(restored[0], NSRect(x: 1_020, y: 380, width: 900, height: 700))
        XCTAssertEqual(restored[1], visibleFrame)
    }

    func testUnreasonablySmallAndNonFiniteFramesAreNotSerializedOrRestored() throws {
        let frames = [
            NSRect(x: 0, y: 0, width: CGFloat.nan, height: 600),
            NSRect(x: 0, y: 0, width: 50, height: 50),
            NSRect(x: 10, y: 10, width: 800, height: 600),
        ]

        let data = try XCTUnwrap(WindowRestorationCodec.encode(frames: frames))
        let restored = WindowRestorationCodec.decode(data, visibleFrames: [visibleFrame])

        XCTAssertEqual(restored, [NSRect(x: 10, y: 10, width: 800, height: 600)])
    }
}
