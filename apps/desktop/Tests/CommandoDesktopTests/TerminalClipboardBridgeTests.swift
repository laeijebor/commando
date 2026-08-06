import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class TerminalClipboardBridgeTests: XCTestCase {
    private let png = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!

    func testAddsPNGWhilePreservingAnImageFileURL() throws {
        let (directory, imageURL) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }

        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([imageURL as NSURL]))
        XCTAssertNil(pasteboard.data(forType: .png))

        XCTAssertEqual(
            TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard),
            .addedPNG
        )

        let convertedPNG = try XCTUnwrap(pasteboard.data(forType: .png))
        XCTAssertEqual(convertedPNG.prefix(8), Data([137, 80, 78, 71, 13, 10, 26, 10]))
        XCTAssertNotNil(NSImage(data: convertedPNG))
        let URLs = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL]
        XCTAssertEqual(URLs, [imageURL])
    }

    func testControlVNormalizesTheClipboardBeforeSendingInput() throws {
        let (directory, imageURL) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([imageURL as NSURL]))
        var inputs: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "image-control-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        let controlV = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .control,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))

        XCTAssertTrue(surface.view.handleControlV(controlV))

        XCTAssertNotNil(pasteboard.data(forType: .png))
        XCTAssertEqual(inputs, [Data([0x16])])
        surface.destroy()
    }

    func testLeavesExistingPNGUnchanged() {
        let pasteboard = makePasteboard()
        pasteboard.setData(png, forType: .png)
        let changeCount = pasteboard.changeCount

        XCTAssertEqual(
            TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard),
            .unchanged
        )
        XCTAssertEqual(pasteboard.changeCount, changeCount)
        XCTAssertEqual(pasteboard.data(forType: .png), png)
    }

    func testLeavesTextClipboardUnchanged() {
        let pasteboard = makePasteboard()
        pasteboard.setString("plain text", forType: .string)
        let changeCount = pasteboard.changeCount

        XCTAssertEqual(
            TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard),
            .unavailable
        )
        XCTAssertEqual(pasteboard.changeCount, changeCount)
        XCTAssertEqual(pasteboard.string(forType: .string), "plain text")
    }

    func testReadsOnlyBoundedNonemptyPlainText() {
        let pasteboard = makePasteboard()
        let maximumUTF8Text = String(
            repeating: "\u{e9}",
            count: NativeTerminalProtocol.maxPasteBytes / 2
        )
        pasteboard.setString(maximumUTF8Text, forType: .string)
        XCTAssertEqual(TerminalClipboardBridge.boundedPlainText(in: pasteboard), maximumUTF8Text)

        for invalid in [
            "",
            "bad\0paste",
            maximumUTF8Text + "x",
        ] {
            pasteboard.clearContents()
            pasteboard.setString(invalid, forType: .string)
            XCTAssertNil(TerminalClipboardBridge.boundedPlainText(in: pasteboard))
        }
    }

    func testCommandVPastesOneTextEventWithoutSendingTerminalInput() throws {
        let pasteboard = makePasteboard()
        pasteboard.setString("line one\nline two", forType: .string)
        var pasted: [String] = []
        var inputs: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "command-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .paste(text) = event { pasted.append(text) }
            if case let .input(data) = event { inputs.append(data) }
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(surface.view)
        XCTAssertTrue(window.makeFirstResponder(surface.view))
        let commandV = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))

        XCTAssertTrue(surface.view.performKeyEquivalent(with: commandV))
        XCTAssertEqual(pasted, ["line one\nline two"])
        XCTAssertTrue(inputs.isEmpty)
        surface.destroy()
        window.contentView = nil
        window.orderOut(nil)
    }

    private func makePasteboard() -> NSPasteboard {
        let pasteboard = NSPasteboard(name: .init("CommandoClipboardTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        addTeardownBlock { pasteboard.clearContents() }
        return pasteboard
    }

    private func makeImageFile() throws -> (directory: URL, image: URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CommandoClipboardTests-\(UUID().uuidString)", isDirectory: true)
        let image = directory.appendingPathComponent("clipboard image.png")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try png.write(to: image)
        return (directory, image)
    }
}
