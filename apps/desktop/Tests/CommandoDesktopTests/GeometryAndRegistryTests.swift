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
            .init(
                frame: .init(x: 100, y: 450, width: 400, height: 200),
                visibleFrames: [.init(x: 100, y: 450, width: 400, height: 200)],
                isHidden: false
            )
        )
    }

    func testPreservesPartiallyClippedVisibleRegions() {
        let partial = TerminalGeometry.placement(
            for: frame(x: 950, y: 650, width: 100, height: 100, scale: 2),
            viewportSize: .init(width: 1_000, height: 700),
            backingScale: 2
        )
        XCTAssertFalse(partial.isHidden)
        XCTAssertEqual(partial.frame, .init(x: 950, y: -50, width: 100, height: 100))
        XCTAssertEqual(partial.visibleFrames, [.init(x: 950, y: 0, width: 50, height: 50)])

        let negativeOrigin = TerminalGeometry.placement(
            for: frame(x: -1, y: 20, width: 100, height: 50, scale: 2),
            viewportSize: .init(width: 800, height: 600),
            backingScale: 2
        )
        XCTAssertFalse(negativeOrigin.isHidden)
        XCTAssertEqual(negativeOrigin.visibleFrames, [.init(x: 0, y: 530, width: 99, height: 50)])
    }

    func testAccountsForScaleWhenFrameIsFullyContained() {
        let scaled = TerminalGeometry.placement(
            for: frame(x: 10, y: 20, width: 100, height: 50, scale: 3),
            viewportSize: .init(width: 800, height: 600),
            backingScale: 2
        )
        XCTAssertEqual(
            scaled,
            .init(
                frame: .init(x: 15, y: 495, width: 150, height: 75),
                visibleFrames: [.init(x: 15, y: 495, width: 150, height: 75)],
                isHidden: false
            )
        )
    }

    func testAccountsForWebKitPageZoomInLayoutCoordinates() {
        let zoomed = TerminalGeometry.placement(
            for: frame(x: 100, y: 50, width: 400, height: 200, scale: 2),
            viewportSize: .init(width: 1_000, height: 700),
            backingScale: 2,
            contentScale: 1.25
        )
        XCTAssertEqual(
            zoomed,
            .init(
                frame: .init(x: 125, y: 387.5, width: 500, height: 250),
                visibleFrames: [.init(x: 125, y: 387.5, width: 500, height: 250)],
                isHidden: false
            )
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

    func testSourceGridLayoutFitsOwnersAndExposesNonOwnerOverflow() {
        let viewport = CGRect(x: 10, y: 100, width: 400, height: 300)
        XCTAssertEqual(
            TerminalSourceGridLayout.frame(
                viewport: viewport,
                sourceContentSize: .init(width: 700, height: 500),
                resizeOwner: false
            ),
            CGRect(x: 10, y: -100, width: 700, height: 500)
        )
        XCTAssertEqual(
            TerminalSourceGridLayout.frame(
                viewport: viewport,
                sourceContentSize: .init(width: 700, height: 500),
                resizeOwner: true
            ),
            viewport
        )
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
        visible: Bool = true,
        visibleRegions: [PaneVisibleRegion]? = nil
    ) -> PaneFramePayload {
        .init(
            identity: .init(paneId: "%1", attachmentId: "a"),
            x: x,
            y: y,
            width: width,
            height: height,
            scale: scale,
            visible: visible,
            visibleRegions: visibleRegions ?? [
                .init(x: x, y: y, width: width, height: height),
            ],
            resizeOwner: true,
            order: 0
        )
    }
}
