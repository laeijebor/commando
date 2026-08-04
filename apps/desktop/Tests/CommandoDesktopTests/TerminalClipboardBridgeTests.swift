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
