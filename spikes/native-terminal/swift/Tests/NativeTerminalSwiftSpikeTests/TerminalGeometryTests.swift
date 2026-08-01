import XCTest
@testable import NativeTerminalSwiftSpike

final class TerminalGeometryTests: XCTestCase {
    func testConvertsTopLeftCSSCoordinatesToAppKitCoordinates() {
        let placement = TerminalGeometry.placement(
            for: .init(x: 100, y: 50, width: 400, height: 200, visible: true, scale: 2),
            viewportWidth: 1_000,
            viewportHeight: 700,
            backingScale: 2
        )

        XCTAssertEqual(
            placement,
            .init(x: 100, y: 450, width: 400, height: 200, isHidden: false)
        )
    }

    func testClipsPlacementToViewportBounds() {
        let placement = TerminalGeometry.placement(
            for: .init(x: 950, y: 650, width: 100, height: 100, visible: true, scale: 2),
            viewportWidth: 1_000,
            viewportHeight: 700,
            backingScale: 2
        )

        XCTAssertEqual(
            placement,
            .init(x: 950, y: 0, width: 50, height: 50, isHidden: false)
        )
    }

    func testAccountsForCSSScaleRelativeToBackingScale() {
        let placement = TerminalGeometry.placement(
            for: .init(x: 10, y: 20, width: 100, height: 50, visible: true, scale: 3),
            viewportWidth: 800,
            viewportHeight: 600,
            backingScale: 2
        )

        XCTAssertEqual(
            placement,
            .init(x: 15, y: 495, width: 150, height: 75, isHidden: false)
        )
    }

    func testHidesInvisibleFrame() {
        let placement = TerminalGeometry.placement(
            for: .init(x: 100, y: 50, width: 400, height: 200, visible: false, scale: 2),
            viewportWidth: 1_000,
            viewportHeight: 700,
            backingScale: 2
        )

        XCTAssertTrue(placement.isHidden)
        XCTAssertEqual(placement.width, 0)
        XCTAssertEqual(placement.height, 0)
    }
}
