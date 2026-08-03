import XCTest
@testable import CommandoDesktop

final class GeometryAndRegistryTests: XCTestCase {
    func testConvertsTopLeftCSSFrameToAppKitCoordinates() {
        let placement = TerminalGeometry.placement(
            for: frame(x: 100, y: 50, width: 400, height: 200, scale: 2),
            viewportSize: .init(width: 1_000, height: 700),
            backingScale: 2
        )
        XCTAssertEqual(
            placement,
            .init(frame: .init(x: 100, y: 450, width: 400, height: 200), isHidden: false)
        )
    }

    func testHidesPartiallyClippedFrameInsteadOfReflowingIt() {
        let partial = TerminalGeometry.placement(
            for: frame(x: 950, y: 650, width: 100, height: 100, scale: 2),
            viewportSize: .init(width: 1_000, height: 700),
            backingScale: 2
        )
        XCTAssertTrue(partial.isHidden)
        XCTAssertEqual(partial.frame, .zero)

        let negativeOrigin = TerminalGeometry.placement(
            for: frame(x: -1, y: 20, width: 100, height: 50, scale: 2),
            viewportSize: .init(width: 800, height: 600),
            backingScale: 2
        )
        XCTAssertTrue(negativeOrigin.isHidden)
    }

    func testAccountsForScaleWhenFrameIsFullyContained() {
        let scaled = TerminalGeometry.placement(
            for: frame(x: 10, y: 20, width: 100, height: 50, scale: 3),
            viewportSize: .init(width: 800, height: 600),
            backingScale: 2
        )
        XCTAssertEqual(
            scaled,
            .init(frame: .init(x: 15, y: 495, width: 150, height: 75), isHidden: false)
        )
    }

    func testHidesInvisibleZeroSizedAndOutsideFrames() {
        let viewport = CGSize(width: 800, height: 600)
        XCTAssertTrue(TerminalGeometry.placement(
            for: frame(visible: false), viewportSize: viewport, backingScale: 2
        ).isHidden)
        XCTAssertTrue(TerminalGeometry.placement(
            for: frame(width: 0), viewportSize: viewport, backingScale: 2
        ).isHidden)
        XCTAssertTrue(TerminalGeometry.placement(
            for: frame(x: 900), viewportSize: viewport, backingScale: 2
        ).isHidden)
    }

    func testResizeGateRequiresVisibleOwnerAndDeduplicates() {
        var gate = ResizeEmissionGate()
        XCTAssertFalse(gate.shouldEmit(cols: 80, rows: 24, isVisible: false, isResizeOwner: true))
        XCTAssertFalse(gate.shouldEmit(cols: 80, rows: 24, isVisible: true, isResizeOwner: false))
        XCTAssertTrue(gate.shouldEmit(cols: 80, rows: 24, isVisible: true, isResizeOwner: true))
        XCTAssertFalse(gate.shouldEmit(cols: 80, rows: 24, isVisible: true, isResizeOwner: true))
        XCTAssertTrue(gate.shouldEmit(cols: 100, rows: 30, isVisible: true, isResizeOwner: true))
        XCTAssertFalse(gate.shouldEmit(cols: 1, rows: 30, isVisible: true, isResizeOwner: true))

        XCTAssertFalse(gate.shouldEmit(cols: 100, rows: 30, isVisible: false, isResizeOwner: true))
        XCTAssertTrue(gate.shouldEmit(cols: 100, rows: 30, isVisible: true, isResizeOwner: true))
        XCTAssertFalse(gate.shouldEmit(cols: 100, rows: 30, isVisible: true, isResizeOwner: false))
        XCTAssertTrue(gate.shouldEmit(cols: 100, rows: 30, isVisible: true, isResizeOwner: true))
    }

    func testAttachmentReplacementAndStaleDetach() {
        var registry = AttachmentRegistry<String>(maximumCount: 2)
        let first = PaneIdentity(paneId: "%1", attachmentId: "first")
        let replacement = PaneIdentity(paneId: "%1", attachmentId: "replacement")

        XCTAssertNil(registry.insert("one", for: first))
        XCTAssertEqual(registry.insert("two", for: replacement)?.value, "one")
        XCTAssertNil(registry.remove(first))
        XCTAssertEqual(registry.record(for: replacement)?.value, "two")
        XCTAssertEqual(registry.remove(replacement)?.value, "two")
        XCTAssertEqual(registry.count, 0)
    }

    func testRegistryEnforcesMaximumSurfacesButAllowsReplacement() {
        var registry = AttachmentRegistry<Int>(maximumCount: NativeTerminalProtocol.maxPanes)
        for index in 1...NativeTerminalProtocol.maxPanes {
            let identity = PaneIdentity(paneId: "%\(index)", attachmentId: "a-\(index)")
            XCTAssertTrue(registry.canInsert(identity))
            registry.insert(index, for: identity)
        }
        XCTAssertEqual(registry.count, 64)
        XCTAssertFalse(registry.canInsert(.init(paneId: "%65", attachmentId: "new")))
        XCTAssertTrue(registry.canInsert(.init(paneId: "%1", attachmentId: "replacement")))
    }

    func testSurfaceOrderIsDeterministic() {
        let values = [
            SurfaceOrderKey(order: 2, paneId: "%1", attachmentId: "b"),
            SurfaceOrderKey(order: 1, paneId: "%2", attachmentId: "a"),
            SurfaceOrderKey(order: 1, paneId: "%1", attachmentId: "z"),
            SurfaceOrderKey(order: 1, paneId: "%1", attachmentId: "a"),
        ].sorted()
        XCTAssertEqual(values, [
            .init(order: 1, paneId: "%1", attachmentId: "a"),
            .init(order: 1, paneId: "%1", attachmentId: "z"),
            .init(order: 1, paneId: "%2", attachmentId: "a"),
            .init(order: 2, paneId: "%1", attachmentId: "b"),
        ])
    }

    private func frame(
        x: Double = 0,
        y: Double = 0,
        width: Double = 100,
        height: Double = 100,
        scale: Double = 2,
        visible: Bool = true
    ) -> PaneFramePayload {
        .init(
            identity: .init(paneId: "%1", attachmentId: "a"),
            x: x,
            y: y,
            width: width,
            height: height,
            scale: scale,
            visible: visible,
            resizeOwner: true,
            order: 0
        )
    }
}
