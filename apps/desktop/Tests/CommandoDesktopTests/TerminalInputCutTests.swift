import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class TerminalInputCutTests: XCTestCase {
    func testSharedExtractionFixtures() throws {
        struct Fixture: Decodable {
            struct Expected: Decodable {
                let text: String
                let clear: String
            }
            let name: String
            let rows: [String]
            let cols: Int
            let cursorRow: Int
            let cursorCol: Int
            let wrapped: [Bool]?
            let expected: Expected?
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/fixtures/terminal-input-cut.json"))
        for fixture in try JSONDecoder().decode([Fixture].self, from: data) {
            let result = TerminalInputCut.extract(
                rows: fixture.rows, cols: fixture.cols,
                cursorRow: fixture.cursorRow, cursorCol: fixture.cursorCol, wrapped: fixture.wrapped
            )
            XCTAssertEqual(result, fixture.expected.map { TerminalInputCut(text: $0.text, clear: $0.clear) }, fixture.name)
        }
    }

    func testMacEditingActionMapping() {
        let mappings: [(UInt16, String?, HostedTerminalView.MacEditingAction)] = [
            (123, nil, .input(Data([0x01]))),
            (124, nil, .input(Data([0x05]))),
            (51, nil, .input(Data([0x15]))),
            (117, nil, .input(Data([0x0b]))),
            (6, "z", .input(Data([0x1f]))),
            (6, "Z", .input(Data([0x1f]))),
            (0, "a", .selectAll),
            (7, "x", .cut),
        ]
        for (code, chars, expected) in mappings {
            XCTAssertEqual(HostedTerminalView.macEditingAction(
                keyCode: code, modifiers: [.command, .function, .numericPad], characters: chars
            ), expected)
            for modifiers: NSEvent.ModifierFlags in [[], .option, [.command, .shift], [.command, .option], [.command, .control]] {
                XCTAssertNil(HostedTerminalView.macEditingAction(keyCode: code, modifiers: modifiers, characters: chars))
            }
        }
        XCTAssertNotEqual(HostedTerminalView.macEditingAction(
            keyCode: 6, modifiers: .command, characters: "z"
        ), .input(Data([0x1a])))
        for chars in ["c", "v", "k", "1", "9", "f", "g"] {
            XCTAssertNil(HostedTerminalView.macEditingAction(keyCode: 0, modifiers: .command, characters: chars))
        }
    }

    func testFocusedKeyRoutingAndCutClipboard() throws {
        let pasteboard = NSPasteboard(name: .init("terminal-cut-\(UUID().uuidString)"))
        var inputs: [Data] = []
        var copiedCount = 0
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "mac-editing"),
            ariaLabel: "Terminal", prefersMetal: false, pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
            if case .selectionCopied = event { copiedCount += 1 }
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView?.addSubview(surface.view)
        defer {
            surface.destroy()
            window.contentView = nil
            window.orderOut(nil)
            pasteboard.releaseGlobally()
        }
        XCTAssertTrue(window.makeFirstResponder(surface.view))
        for (code, byte): (UInt16, UInt8) in [(123, 0x01), (124, 0x05), (51, 0x15), (117, 0x0b), (6, 0x1f)] {
            XCTAssertTrue(surface.view.performKeyEquivalent(with: try key(code, code == 6 ? "z" : "")))
            XCTAssertEqual(inputs.last, Data([byte]))
        }
        inputs.removeAll()
        surface.view.feed(text: "$ echo 界\u{1b}[2m ghost suggestion\u{1b}[0m")
        XCTAssertTrue(surface.view.performKeyEquivalent(with: try key(7, "x")))
        XCTAssertEqual(pasteboard.string(forType: .string), "echo 界")
        XCTAssertEqual(inputs, [Data([0x05, 0x15])])
        XCTAssertEqual(copiedCount, 1)

        inputs.removeAll()
        XCTAssertTrue(surface.view.performKeyEquivalent(with: try key(0, "a")))
        let selection = try XCTUnwrap(surface.view.getSelection())
        XCTAssertFalse(selection.isEmpty)
        XCTAssertTrue(surface.view.performKeyEquivalent(with: try key(7, "x")))
        XCTAssertEqual(pasteboard.string(forType: .string), selection)
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertEqual(copiedCount, 2)

        surface.view.selectNone()
        surface.view.getTerminal().resetToInitialState()
        surface.view.feed(text: String(repeating: "─", count: 40) + "\r\n❯ \u{1b}[2mplaceholder\u{1b}[0m\r\n"
                          + String(repeating: "─", count: 40))
        surface.view.feed(text: "\u{1b}[2;3H")
        XCTAssertTrue(surface.view.performKeyEquivalent(with: try key(7, "x")))
        XCTAssertTrue(inputs.isEmpty)
        XCTAssertEqual(pasteboard.string(forType: .string), selection)
        XCTAssertEqual(copiedCount, 2)

        _ = window.makeFirstResponder(window.contentView)
        XCTAssertFalse(surface.view.performKeyEquivalent(with: try key(6, "z")))
        XCTAssertTrue(inputs.isEmpty)
    }

    private func key(_ code: UInt16, _ chars: String) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [.command, .function, .numericPad],
            timestamp: 0, windowNumber: 0, context: nil, characters: chars,
            charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code
        ))
    }
}
