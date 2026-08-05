import AppKit
import Metal
import XCTest
@testable import CommandoDesktop

@MainActor
final class TerminalPaneHostTests: XCTestCase {
    func testReplacementStaleDetachAndCleanupLeaveExpectedViewCount() {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let first = PaneIdentity(paneId: "%1", attachmentId: "first")
        let replacement = PaneIdentity(paneId: "%1", attachmentId: "replacement")
        let second = PaneIdentity(paneId: "%2", attachmentId: "second")

        XCTAssertEqual(host.attach(.init(identity: first, ariaLabel: "First")), .attached)
        XCTAssertEqual(host.attach(.init(identity: second, ariaLabel: "Second")), .attached)
        XCTAssertEqual(host.surfaceCount, 2)
        XCTAssertEqual(overlay.subviews.count, 2)

        XCTAssertEqual(host.attach(.init(identity: replacement, ariaLabel: "Replacement")), .replaced)
        XCTAssertEqual(host.surfaceCount, 2)
        XCTAssertEqual(overlay.subviews.count, 2)
        XCTAssertFalse(host.detach(first))
        XCTAssertEqual(overlay.subviews.count, 2)

        XCTAssertTrue(host.detach(replacement))
        XCTAssertEqual(host.surfaceCount, 1)
        XCTAssertEqual(overlay.subviews.count, 1)
        host.destroyAll()
        XCTAssertEqual(host.surfaceCount, 0)
        XCTAssertEqual(overlay.subviews.count, 0)
    }

    func testInputIsChunkedWithoutUtf8Conversion() {
        var chunks: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "a"),
            ariaLabel: "Terminal",
            prefersMetal: false
        ) { event in
            if case let .input(data) = event { chunks.append(data) }
        }
        let bytes = (0..<(NativeTerminalProtocol.maxInputBytes * 2 + 17)).map {
            UInt8(truncatingIfNeeded: $0)
        }
        surface.send(source: surface.view, data: bytes[...])

        XCTAssertEqual(chunks.map(\.count), [
            NativeTerminalProtocol.maxInputBytes,
            NativeTerminalProtocol.maxInputBytes,
            17,
        ])
        XCTAssertEqual(chunks.reduce(into: Data(), { $0.append($1) }), Data(bytes))
        XCTAssertEqual(chunks.first?.first, 0)
        surface.destroy()
    }

    func testZoomScaleAppliesToExistingAndFutureTerminalSurfaces() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let first = PaneIdentity(paneId: "%1", attachmentId: "first")
        let second = PaneIdentity(paneId: "%2", attachmentId: "second")
        host.attach(.init(identity: first, ariaLabel: "First"))

        host.setZoomScale(1.2)
        XCTAssertEqual(host.zoomScale, 1.2)
        let firstSurface = try XCTUnwrap(host.registry.record(for: first)?.value)
        XCTAssertEqual(
            firstSurface.view.font.pointSize,
            TerminalProfile.fontSize * 1.2,
            accuracy: 0.001
        )

        host.attach(.init(identity: second, ariaLabel: "Second"))
        let secondSurface = try XCTUnwrap(host.registry.record(for: second)?.value)
        XCTAssertEqual(
            secondSurface.view.font.pointSize,
            TerminalProfile.fontSize * 1.2,
            accuracy: 0.001
        )
        host.destroyAll()
    }

    func testNonOwnerSourceGridSurvivesFrameZoomFocusAndReseed() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        var contextMenuPoints: [CGPoint] = []
        let window = NSWindow(
            contentRect: overlay.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = overlay
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, event in
                if case let .contextMenu(point) = event { contextMenuPoints.append(point) }
            }
        )
        let identity = PaneIdentity(paneId: "%1", attachmentId: "zoom-frame")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))
        XCTAssertTrue(host.applyReset(.init(
            identity: identity,
            data: Data("source grid".utf8),
            cols: 120,
            rows: 40,
            revision: 1
        )))
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            visible: true,
            resizeOwner: false,
            scale: Double(window.backingScaleFactor)
        )))
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        XCTAssertEqual(surface.view.getTerminal().cols, 120)
        XCTAssertEqual(surface.view.getTerminal().rows, 40)
        XCTAssertGreaterThan(surface.view.frame.width, 400)
        XCTAssertGreaterThan(surface.view.frame.height, 300)
        XCTAssertEqual(surface.view.frame.minX, 10, accuracy: 0.001)
        XCTAssertEqual(surface.view.frame.maxY, 590, accuracy: 0.001)
        surface.view.rightMouseDown(with: try XCTUnwrap(mouseEvent(
            type: .rightMouseDown,
            location: CGPoint(x: 210, y: 440),
            modifiers: .option
        )))
        XCTAssertEqual(contextMenuPoints, [CGPoint(x: 210, y: 160)])
        XCTAssertTrue(window.firstResponder === surface.view)
        let unzoomedSize = surface.view.frame.size

        XCTAssertTrue(host.focus(identity))
        XCTAssertTrue(surface.isFocused)

        host.setZoomScale(1.2)

        XCTAssertEqual(surface.view.getTerminal().cols, 120)
        XCTAssertEqual(surface.view.getTerminal().rows, 40)
        XCTAssertGreaterThan(surface.view.frame.width, unzoomedSize.width)
        XCTAssertGreaterThan(surface.view.frame.height, unzoomedSize.height)
        XCTAssertEqual(surface.view.frame.minX, 12, accuracy: 0.001)
        XCTAssertEqual(surface.view.frame.maxY, 588, accuracy: 0.001)
        XCTAssertTrue(surface.isFocused)

        XCTAssertTrue(host.applyReset(.init(
            identity: identity,
            data: Data("replacement grid".utf8),
            cols: 91,
            rows: 31,
            revision: 2
        )))
        XCTAssertEqual(surface.view.getTerminal().cols, 91)
        XCTAssertEqual(surface.view.getTerminal().rows, 31)
        XCTAssertTrue(surface.isFocused)
        host.destroyAll()
        window.contentView = nil
        window.orderOut(nil)
    }

    func testOwnerResizeBecomesSourceGridBeforeOwnershipIsReleased() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        var resizeEvents: [GridSize] = []
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false
        ) { _, event in
            if case let .resize(size) = event { resizeEvents.append(size) }
        }
        let identity = PaneIdentity(paneId: "%1", attachmentId: "owner-source")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))
        XCTAssertTrue(host.applyReset(.init(
            identity: identity,
            data: Data("source A".utf8),
            cols: 80,
            rows: 24,
            revision: 1
        )))

        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 700,
            visible: true,
            resizeOwner: true
        )))
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        let ownerGrid = GridSize(
            cols: surface.view.getTerminal().cols,
            rows: surface.view.getTerminal().rows
        )
        XCTAssertNotEqual(ownerGrid, GridSize(cols: 80, rows: 24))
        XCTAssertEqual(resizeEvents.last, ownerGrid)

        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 700,
            visible: true,
            resizeOwner: false
        )))
        XCTAssertEqual(surface.view.getTerminal().cols, ownerGrid.cols)
        XCTAssertEqual(surface.view.getTerminal().rows, ownerGrid.rows)
        host.destroyAll()
    }

    func testOwnerZoomSuppressesTransientResizeEvents() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 900, height: 700))
        var resizeEvents: [GridSize] = []
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false
        ) { _, event in
            if case let .resize(size) = event { resizeEvents.append(size) }
        }
        let identity = PaneIdentity(paneId: "%1", attachmentId: "owner-zoom")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))
        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: true)))
        resizeEvents.removeAll()

        host.setZoomScale(1.2)

        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        let finalGrid = GridSize(
            cols: surface.view.getTerminal().cols,
            rows: surface.view.getTerminal().rows
        )
        XCTAssertLessThanOrEqual(resizeEvents.count, 1)
        if let emitted = resizeEvents.last { XCTAssertEqual(emitted, finalGrid) }
        host.destroyAll()
    }

    func testNonOwnerSourceGridOverflowScrollsOnBothAxesAndClamps() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let identity = PaneIdentity(paneId: "%1", attachmentId: "overflow")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))
        XCTAssertTrue(host.applyReset(.init(
            identity: identity,
            data: Data("overflow".utf8),
            cols: 120,
            rows: 40,
            revision: 1
        )))
        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: false)))
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        let initialFrame = surface.view.frame
        let initialVisibleFrame = surface.view.visibleHitRegions[0].offsetBy(
            dx: initialFrame.minX,
            dy: initialFrame.minY
        )

        XCTAssertTrue(surface.scrollSourceGrid(by: CGSize(width: 60, height: 80)))
        XCTAssertEqual(surface.sourceScrollOffset, CGPoint(x: 60, y: 80))
        XCTAssertEqual(surface.view.frame.minX, initialFrame.minX - 60, accuracy: 0.001)
        XCTAssertEqual(surface.view.frame.minY, initialFrame.minY + 80, accuracy: 0.001)
        XCTAssertEqual(
            surface.view.visibleHitRegions[0].offsetBy(
                dx: surface.view.frame.minX,
                dy: surface.view.frame.minY
            ),
            initialVisibleFrame
        )

        XCTAssertTrue(surface.scrollSourceGrid(by: CGSize(width: 100_000, height: 100_000)))
        XCTAssertEqual(
            surface.sourceScrollOffset.x,
            surface.view.frame.width - initialVisibleFrame.width,
            accuracy: 0.001
        )
        XCTAssertEqual(
            surface.sourceScrollOffset.y,
            surface.view.frame.height - initialVisibleFrame.height,
            accuracy: 0.001
        )
        XCTAssertFalse(surface.scrollSourceGrid(by: CGSize(width: 1, height: 1)))

        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: true)))
        XCTAssertEqual(surface.sourceScrollOffset, .zero)
        XCTAssertFalse(surface.scrollSourceGrid(by: CGSize(width: 10, height: 10)))
        host.destroyAll()
    }

    func testSourceGridScrollPolicyPreservesOrdinaryTUIMouseInput() {
        XCTAssertNil(SourceGridScrollPolicy.delta(
            horizontal: 20,
            vertical: -30,
            hasPreciseDeltas: true,
            modifiers: [],
            mouseReportingActive: true,
            alternateBuffer: false,
            scrollbackAtBottom: true
        ))
        XCTAssertEqual(SourceGridScrollPolicy.delta(
            horizontal: 0,
            vertical: -2,
            hasPreciseDeltas: false,
            modifiers: .shift,
            mouseReportingActive: true,
            alternateBuffer: true,
            scrollbackAtBottom: false
        ), CGSize(width: 48, height: 0))
        XCTAssertEqual(SourceGridScrollPolicy.delta(
            horizontal: 0,
            vertical: -2,
            hasPreciseDeltas: false,
            modifiers: [.option, .shift],
            mouseReportingActive: true,
            alternateBuffer: true,
            scrollbackAtBottom: false
        ), CGSize(width: 0, height: 48))
        XCTAssertNil(SourceGridScrollPolicy.delta(
            horizontal: 0,
            vertical: -2,
            hasPreciseDeltas: false,
            modifiers: [],
            mouseReportingActive: false,
            alternateBuffer: true,
            scrollbackAtBottom: true
        ))
        XCTAssertNil(SourceGridScrollPolicy.delta(
            horizontal: 0,
            vertical: -2,
            hasPreciseDeltas: false,
            modifiers: [],
            mouseReportingActive: false,
            alternateBuffer: false,
            scrollbackAtBottom: false
        ))
        XCTAssertEqual(SourceGridScrollPolicy.delta(
            horizontal: 0,
            vertical: -2,
            hasPreciseDeltas: false,
            modifiers: [],
            mouseReportingActive: false,
            alternateBuffer: false,
            scrollbackAtBottom: true
        ), CGSize(width: 0, height: 48))
    }

    func testMetadataUpdateAppliesNativeAccessibilityWithoutReattaching() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let identity = PaneIdentity(paneId: "%1", attachmentId: "metadata")
        let shortcuts = ["Meta+C", "Meta+V", "PageUp", "PageDown"]
        XCTAssertEqual(host.attach(.init(
            identity: identity,
            ariaLabel: "Terminal",
            accessibilityEnabled: true,
            keyShortcuts: shortcuts
        )), .attached)
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)

        XCTAssertEqual(surface.view.accessibilityLabel(), "Terminal")
        XCTAssertTrue(surface.view.isAccessibilityEnabled())
        XCTAssertEqual(surface.view.accessibilityRole(), .textArea)
        XCTAssertTrue(surface.view.accessibilityHelp()?.contains("Meta+C, Meta+V, PageUp, PageDown") == true)

        XCTAssertTrue(host.update(.init(
            identity: identity,
            metadata: .init(
                ariaLabel: "Terminal, disconnected",
                accessibilityEnabled: false,
                keyShortcuts: shortcuts
            )
        )))
        XCTAssertEqual(host.surfaceCount, 1)
        XCTAssertEqual(surface.view.accessibilityLabel(), "Terminal, disconnected")
        XCTAssertFalse(surface.view.isAccessibilityEnabled())
        host.destroyAll()
    }

    func testTerminalInterceptsOnlyProductCommandShortcuts() throws {
        var shortcuts: [String] = []
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        view.shortcutWasPressed = { shortcuts.append($0) }

        let commandK = try XCTUnwrap(keyEvent(key: "k", modifiers: .command, keyCode: 40))
        let command4 = try XCTUnwrap(keyEvent(key: "4", modifiers: .command, keyCode: 21))
        let shiftedCommandK = try XCTUnwrap(keyEvent(
            key: "K",
            modifiers: [.command, .shift],
            keyCode: 40
        ))
        XCTAssertTrue(view.performKeyEquivalent(with: commandK))
        XCTAssertTrue(view.performKeyEquivalent(with: command4))
        _ = view.performKeyEquivalent(with: shiftedCommandK)
        XCTAssertEqual(shortcuts, ["k", "4"])
    }

    func testTerminalSendsXtermOptionArrowSequences() throws {
        var inputs: [Data] = []
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        view.modifiedArrowWasPressed = { inputs.append($0) }

        let optionUp = try XCTUnwrap(keyEvent(key: "", modifiers: .option, keyCode: 126))
        let optionDown = try XCTUnwrap(keyEvent(key: "", modifiers: .option, keyCode: 125))
        let plainUp = try XCTUnwrap(keyEvent(key: "", modifiers: [], keyCode: 126))
        XCTAssertTrue(view.handleOptionArrow(optionUp))
        XCTAssertTrue(view.handleOptionArrow(optionDown))

        XCTAssertEqual(inputs, [
            Data([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41]),
            Data([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42]),
        ])
        XCTAssertFalse(view.handleOptionArrow(plainUp))
    }

    func testTerminalSendsRawControlVToThePaneInKittyKeyboardMode() throws {
        var inputs: [Data] = []
        let pasteboard = NSPasteboard(name: .init("CommandoDesktopTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("text", forType: .string)
        defer { pasteboard.clearContents() }
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "control-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        let controlV = try XCTUnwrap(keyEvent(key: "v", modifiers: .control, keyCode: 9))
        let commandV = try XCTUnwrap(keyEvent(key: "v", modifiers: .command, keyCode: 9))
        let shiftedControlV = try XCTUnwrap(keyEvent(
            key: "V",
            modifiers: [.control, .shift],
            keyCode: 9
        ))
        let kittyMode = Array("\u{1b}[>31u".utf8)
        surface.view.feed(byteArray: kittyMode[...])

        XCTAssertTrue(surface.view.handleControlV(controlV))

        XCTAssertEqual(inputs, [Data([0x16])])
        XCTAssertFalse(surface.view.handleControlV(commandV))
        XCTAssertFalse(surface.view.handleControlV(shiftedControlV))
        surface.destroy()
    }

    func testTerminalAcceptsTheActivationClick() {
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        XCTAssertTrue(view.acceptsFirstMouse(for: nil))
    }

    func testPageUpAndDownScrollNormalBufferButReachAlternateScreen() {
        var inputs: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "page-keys"),
            ariaLabel: "Terminal",
            prefersMetal: false
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        surface.view.resize(cols: 20, rows: 3)
        for line in 0..<12 {
            surface.view.feed(text: "line \(line)\r\n")
        }
        let bottom = surface.view.scrollPosition

        surface.view.pageUp()
        XCTAssertLessThan(surface.view.scrollPosition, bottom)
        surface.view.pageDown()
        XCTAssertEqual(surface.view.scrollPosition, bottom)
        XCTAssertTrue(inputs.isEmpty)

        surface.view.feed(text: "\u{1b}[?1049h")
        XCTAssertTrue(surface.view.getTerminal().isCurrentBufferAlternate)
        surface.view.pageUp()
        surface.view.pageDown()
        XCTAssertEqual(inputs, [
            Data([0x1b, 0x5b, 0x35, 0x7e]),
            Data([0x1b, 0x5b, 0x36, 0x7e]),
        ])
        surface.destroy()
    }

    func testSelectionAutoCopiesWithoutMouseReportingAndShiftBypassesReporting() throws {
        let pasteboard = NSPasteboard(name: .init("CommandoSelectionTests.\(UUID().uuidString)"))
        defer { pasteboard.clearContents() }
        var inputs: [Data] = []
        var copiedCount = 0
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "selection"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
            if case .selectionCopied = event { copiedCount += 1 }
        }
        surface.view.feed(text: "alpha beta gamma")
        surface.view.mouseDown(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDown,
            location: CGPoint(x: 10, y: 290)
        )))
        surface.view.mouseDragged(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDragged,
            location: CGPoint(x: 12, y: 290)
        )))
        surface.view.mouseDragged(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDragged,
            location: CGPoint(x: 80, y: 290)
        )))
        surface.view.mouseUp(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseUp,
            location: CGPoint(x: 80, y: 290)
        )))
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertTrue(surface.view.selectionActive)
        XCTAssertEqual(copiedCount, 1)
        XCTAssertFalse(pasteboard.string(forType: .string)?.isEmpty ?? true)

        surface.view.feed(text: "\u{1b}[?1000h")
        surface.view.mouseDown(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDown,
            location: CGPoint(x: 10, y: 290)
        )))
        surface.view.mouseUp(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseUp,
            location: CGPoint(x: 10, y: 290)
        )))
        XCTAssertFalse(inputs.isEmpty)
        XCTAssertEqual(copiedCount, 1)
        inputs.removeAll()

        surface.view.mouseDown(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDown,
            location: CGPoint(x: 10, y: 290),
            modifiers: .shift
        )))
        surface.view.mouseDragged(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDragged,
            location: CGPoint(x: 12, y: 290),
            modifiers: .shift
        )))
        surface.view.mouseDragged(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseDragged,
            location: CGPoint(x: 80, y: 290),
            modifiers: .shift
        )))
        surface.view.mouseUp(with: try XCTUnwrap(mouseEvent(
            type: .leftMouseUp,
            location: CGPoint(x: 80, y: 290),
            modifiers: .shift
        )))
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertTrue(surface.view.selectionActive)
        XCTAssertEqual(copiedCount, 2)
        XCTAssertFalse(pasteboard.string(forType: .string)?.isEmpty ?? true)

        let commandC = try XCTUnwrap(keyEvent(key: "c", modifiers: .command, keyCode: 8))
        XCTAssertTrue(surface.view.performKeyEquivalent(with: commandC))
        XCTAssertEqual(copiedCount, 3)
        surface.destroy()
    }

    func testOnlyOptionRightClickRequestsNormalizedContextMenu() throws {
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        var points: [CGPoint] = []
        var responderAtRequest: NSResponder?
        view.contextMenuWasRequested = {
            responderAtRequest = window.firstResponder
            points.append($0)
        }

        view.rightMouseDown(with: try XCTUnwrap(mouseEvent(
            type: .rightMouseDown,
            location: CGPoint(x: 100, y: 75)
        )))
        XCTAssertTrue(points.isEmpty)
        view.rightMouseDown(with: try XCTUnwrap(mouseEvent(
            type: .rightMouseDown,
            location: CGPoint(x: 100, y: 75),
            modifiers: .option
        )))
        XCTAssertEqual(points, [CGPoint(x: 0.25, y: 0.75)])
        XCTAssertTrue(responderAtRequest === view)
        window.contentView = nil
        window.orderOut(nil)
    }

    func testOverlayOnlyHitTestsTerminalChildren() {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        XCTAssertNil(overlay.hitTest(NSPoint(x: 10, y: 10)))
        let child = NSView(frame: NSRect(x: 50, y: 50, width: 100, height: 100))
        overlay.addSubview(child)
        XCTAssertTrue(overlay.hitTest(NSPoint(x: 60, y: 60)) === child)
        XCTAssertNil(overlay.hitTest(NSPoint(x: 10, y: 10)))
    }

    func testTerminalMaskAndHitTestingExposeOnlyVisibleRegions() {
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
        view.setVisibleRegions([
            NSRect(x: 0, y: 0, width: 50, height: 100),
            NSRect(x: 150, y: 0, width: 50, height: 100),
        ])

        XCTAssertEqual(view.visibleHitRegions, [
            NSRect(x: 0, y: 0, width: 50, height: 100),
            NSRect(x: 150, y: 0, width: 50, height: 100),
        ])
        XCTAssertNotNil(view.hitTest(NSPoint(x: 25, y: 50)))
        XCTAssertNil(view.hitTest(NSPoint(x: 100, y: 50)))
        XCTAssertNotNil(view.hitTest(NSPoint(x: 175, y: 50)))
        XCTAssertEqual(view.layer?.mask?.frame, view.bounds)
    }

    func testTerminalMaskSurvivesMetalRendererToggleWhenAvailable() throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("Metal is unavailable") }
        let view = HostedTerminalView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        defer {
            if view.isUsingMetalRenderer { try? view.setUseMetal(false) }
            window.contentView = nil
            window.orderOut(nil)
        }
        view.setVisibleRegions([NSRect(x: 0, y: 0, width: 50, height: 100)])
        let mask = try XCTUnwrap(view.layer?.mask)

        do {
            try view.setUseMetal(true)
        } catch {
            throw XCTSkip("SwiftTerm Metal test resources are unavailable: \(error)")
        }
        XCTAssertTrue(view.isUsingMetalRenderer)
        XCTAssertTrue(view.layer?.mask === mask)
        try view.setUseMetal(false)
        XCTAssertFalse(view.isUsingMetalRenderer)
        XCTAssertTrue(view.layer?.mask === mask)
    }

    func testFrameHideShowAndResizeOwnerRules() {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        var resizeEvents: [GridSize] = []
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false
        ) { _, event in
            if case let .resize(size) = event { resizeEvents.append(size) }
        }
        let identity = PaneIdentity(paneId: "%1", attachmentId: "a")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))

        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: false, resizeOwner: true)))
        XCTAssertTrue(overlay.subviews[0].isHidden)
        XCTAssertTrue(resizeEvents.isEmpty)

        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: false)))
        XCTAssertFalse(overlay.subviews[0].isHidden)
        XCTAssertTrue(resizeEvents.isEmpty)

        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: true)))
        XCTAssertEqual(resizeEvents.count, 1)
        let surface = host.registry.record(for: identity)!.value
        XCTAssertEqual(surface.view.frame, NSRect(x: 10, y: 290, width: 400, height: 300))
        XCTAssertEqual(
            resizeEvents.last,
            GridSize(cols: surface.view.getTerminal().cols, rows: surface.view.getTerminal().rows)
        )
        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: false)))
        XCTAssertEqual(resizeEvents.count, 1)
        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: true)))
        XCTAssertEqual(resizeEvents.count, 2)
        let visibleFrame = overlay.subviews[0].frame
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            width: 0,
            visible: true,
            resizeOwner: true
        )))
        XCTAssertTrue(overlay.subviews[0].isHidden)
        XCTAssertEqual(overlay.subviews[0].frame, visibleFrame)
        XCTAssertEqual(resizeEvents.count, 2)
        XCTAssertTrue(host.applyFrame(frame(identity: identity, visible: true, resizeOwner: true)))
        XCTAssertEqual(resizeEvents.count, 3)
        host.destroyAll()
    }

    func testReordersActualSubviewsAndHitTestingUsesFrontmostSurface() {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let low = PaneIdentity(paneId: "%1", attachmentId: "low")
        let high = PaneIdentity(paneId: "%2", attachmentId: "high")
        host.attach(.init(identity: high, ariaLabel: "High"))
        host.attach(.init(identity: low, ariaLabel: "Low"))
        XCTAssertTrue(host.applyFrame(frame(identity: high, visible: true, resizeOwner: false, order: 10)))
        XCTAssertTrue(host.applyFrame(frame(identity: low, visible: true, resizeOwner: false, order: 1)))

        let highView = host.registry.record(for: high)!.value.view
        XCTAssertTrue(overlay.subviews.last === highView)
        let visibleRegion = highView.visibleHitRegions[0]
        let hitPoint = NSPoint(
            x: highView.frame.minX + visibleRegion.midX,
            y: highView.frame.minY + visibleRegion.midY
        )
        let hit = overlay.hitTest(hitPoint)
        XCTAssertTrue(
            hit === highView || hit?.isDescendant(of: highView) == true,
            "Expected high surface, got \(String(describing: hit)) from \(overlay.subviews)"
        )
        host.destroyAll()
    }

    private func frame(
        identity: PaneIdentity,
        width: Double = 400,
        height: Double = 300,
        visible: Bool,
        resizeOwner: Bool,
        order: Int = 0,
        scale: Double = 1
    ) -> PaneFramePayload {
        .init(
            identity: identity,
            x: 10,
            y: 10,
            width: width,
            height: height,
            scale: scale,
            visible: visible,
            visibleRegions: [
                .init(x: 10, y: 10, width: width, height: height),
            ],
            resizeOwner: resizeOwner,
            order: order
        )
    }

    private func keyEvent(
        key: String,
        modifiers: NSEvent.ModifierFlags,
        keyCode: UInt16
    ) -> NSEvent? {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: key,
            charactersIgnoringModifiers: key.lowercased(),
            isARepeat: false,
            keyCode: keyCode
        )
    }

    private func mouseEvent(
        type: NSEvent.EventType,
        location: CGPoint,
        modifiers: NSEvent.ModifierFlags = []
    ) -> NSEvent? {
        NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        )
    }
}
