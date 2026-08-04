import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class DesktopApplicationTests: XCTestCase {
    func testMainMenuIdentifiesCommandoAndProvidesClipboardAndZoomActions() throws {
        let zoomTarget = NSObject()
        let menu = DesktopMainMenu.make(zoomTarget: zoomTarget)

        XCTAssertEqual(menu.items.map(\.title), ["Commando", "Edit", "View"])
        let applicationMenu = try XCTUnwrap(menu.items[0].submenu)
        XCTAssertEqual(applicationMenu.items.first?.title, "About Commando")
        XCTAssertEqual(applicationMenu.items.last?.title, "Quit Commando")
        let editMenu = try XCTUnwrap(menu.items[1].submenu)
        XCTAssertEqual(editMenu.items.map(\.title), ["Copy", "Paste"])
        let viewMenu = try XCTUnwrap(menu.items[2].submenu)
        XCTAssertEqual(viewMenu.items.map(\.title), ["Zoom Out", "Zoom In"])
        XCTAssertEqual(viewMenu.items.map(\.keyEquivalent), ["-", "="])
        XCTAssertTrue(viewMenu.items.allSatisfy { $0.keyEquivalentModifierMask == .command })
        XCTAssertTrue(viewMenu.items.allSatisfy { $0.target === zoomTarget })
    }

    func testWindowRoutesControlVToTheFocusedTerminal() throws {
        var inputs: [Data] = []
        let pasteboard = NSPasteboard(name: .init("CommandoDesktopTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("text", forType: .string)
        defer { pasteboard.clearContents() }
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "window-control-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(surface.view)
        XCTAssertTrue(window.makeFirstResponder(surface.view))
        let controlV = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .control,
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))

        window.sendEvent(controlV)

        XCTAssertEqual(inputs, [Data([0x16])])
        _ = window.makeFirstResponder(nil)
        surface.destroy()
        window.contentView = nil
        window.orderOut(nil)
    }
}
