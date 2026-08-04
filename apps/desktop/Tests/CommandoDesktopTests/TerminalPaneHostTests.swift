import AppKit
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

    func testZoomScaleReappliesTheLatestTerminalFrame() throws {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let host = TerminalPaneHost(
            overlay: overlay,
            fallbackResponder: nil,
            prefersMetal: false,
            eventSink: { _, _ in }
        )
        let identity = PaneIdentity(paneId: "%1", attachmentId: "zoom-frame")
        host.attach(.init(identity: identity, ariaLabel: "Terminal"))
        XCTAssertTrue(host.applyFrame(frame(
            identity: identity,
            visible: true,
            resizeOwner: false
        )))
        let surface = try XCTUnwrap(host.registry.record(for: identity)?.value)
        XCTAssertEqual(surface.view.frame, NSRect(x: 10, y: 290, width: 400, height: 300))

        host.setZoomScale(1.2)

        XCTAssertEqual(surface.view.frame, NSRect(x: 12, y: 228, width: 480, height: 360))
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

    func testOverlayOnlyHitTestsTerminalChildren() {
        let overlay = TerminalOverlayView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        XCTAssertNil(overlay.hitTest(NSPoint(x: 10, y: 10)))
        let child = NSView(frame: NSRect(x: 50, y: 50, width: 100, height: 100))
        overlay.addSubview(child)
        XCTAssertTrue(overlay.hitTest(NSPoint(x: 60, y: 60)) === child)
        XCTAssertNil(overlay.hitTest(NSPoint(x: 10, y: 10)))
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
        let hit = overlay.hitTest(NSPoint(x: highView.frame.midX, y: highView.frame.midY))
        XCTAssertTrue(hit === highView || hit?.isDescendant(of: highView) == true)
        host.destroyAll()
    }

    private func frame(
        identity: PaneIdentity,
        width: Double = 400,
        visible: Bool,
        resizeOwner: Bool,
        order: Int = 0
    ) -> PaneFramePayload {
        .init(
            identity: identity,
            x: 10,
            y: 10,
            width: width,
            height: 300,
            scale: 1,
            visible: visible,
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
}
