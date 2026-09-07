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
        XCTAssertEqual(convertedPNG, png)
        let URLs = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL]
        XCTAssertEqual(URLs, [imageURL])
    }

    func testPrefersImageFileContentsOverPNGAndTIFFIcons() throws {
        let (directory, imageURL) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }
        let icon = try makeIcon()

        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            let pasteboard = makePasteboard()
            let item = NSPasteboardItem()
            let iconData = try XCTUnwrap(icon.representation(
                using: type == .png ? .png : .tiff, properties: [:]
            ))
            XCTAssertTrue(item.setString(imageURL.absoluteString, forType: .fileURL))
            XCTAssertTrue(item.setData(iconData, forType: type))
            XCTAssertTrue(pasteboard.writeObjects([item]))

            XCTAssertEqual(TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard), .addedPNG)
            XCTAssertEqual(pasteboard.data(forType: .png), png)
            XCTAssertEqual(pasteboard.string(forType: .fileURL), imageURL.absoluteString)
            if type == .tiff { XCTAssertEqual(pasteboard.data(forType: .tiff), iconData) }
            let changeCount = pasteboard.changeCount
            XCTAssertEqual(TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard), .unchanged)
            XCTAssertEqual(pasteboard.changeCount, changeCount)
        }
    }

    func testConvertsTIFFFileContentsInsteadOfClipboardPNG() throws {
        let (directory, _) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }
        let imageURL = directory.appendingPathComponent("source.tiff")
        let source = try makeIcon()
        try XCTUnwrap(source.representation(using: .tiff, properties: [:])).write(to: imageURL)
        let pasteboard = makePasteboard()
        let item = NSPasteboardItem()
        XCTAssertTrue(item.setString(imageURL.absoluteString, forType: .fileURL))
        XCTAssertTrue(item.setData(png, forType: .png))
        XCTAssertTrue(pasteboard.writeObjects([item]))

        XCTAssertEqual(TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard), .addedPNG)
        let result = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(pasteboard.data(forType: .png))))
        XCTAssertEqual(result.pixelsWide, source.pixelsWide)
        XCTAssertEqual(result.pixelsHigh, source.pixelsHigh)
        var pixel = [Int](repeating: 0, count: 4)
        result.getPixel(&pixel, atX: 0, y: 0)
        XCTAssertEqual(pixel, [255, 0, 0, 255])
    }

    func testDoesNotConvertIconsForMissingNonImageOrOversizedFiles() throws {
        let (directory, _) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }
        let nonImage = directory.appendingPathComponent("not-an-image.png")
        try Data("not an image".utf8).write(to: nonImage)
        let oversized = directory.appendingPathComponent("oversized.png")
        try png.write(to: oversized)
        let handle = try FileHandle(forWritingTo: oversized)
        try handle.truncate(atOffset: UInt64(TerminalClipboardBridge.maxConvertedPNGBytes + 1))
        try handle.close()
        let icon = try XCTUnwrap(makeIcon().representation(using: .tiff, properties: [:]))

        for url in [nonImage, oversized, directory, directory.appendingPathComponent("missing.png")] {
            let pasteboard = makePasteboard()
            let item = NSPasteboardItem()
            XCTAssertTrue(item.setString(url.absoluteString, forType: .fileURL))
            XCTAssertTrue(item.setData(icon, forType: .tiff))
            XCTAssertTrue(pasteboard.writeObjects([item]))
            let changeCount = pasteboard.changeCount

            XCTAssertEqual(TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard), .unavailable)
            XCTAssertNil(pasteboard.data(forType: .png))
            XCTAssertEqual(pasteboard.changeCount, changeCount)
            XCTAssertEqual(pasteboard.data(forType: .tiff), icon)
        }
    }

    func testConvertsImageOnlyTIFFClipboard() throws {
        let source = try makeIcon()
        let tiff = try XCTUnwrap(source.representation(using: .tiff, properties: [:]))
        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.setData(tiff, forType: .tiff))

        XCTAssertEqual(TerminalClipboardBridge.ensurePNGRepresentation(in: pasteboard), .addedPNG)
        let result = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(pasteboard.data(forType: .png))))
        XCTAssertEqual(result.pixelsWide, source.pixelsWide)
        XCTAssertEqual(result.pixelsHigh, source.pixelsHigh)
        XCTAssertEqual(pasteboard.data(forType: .tiff), tiff)
    }

    func testControlVNormalizesTheClipboardBeforeSendingInput() throws {
        let (directory, imageURL) = try makeImageFile()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pasteboard = makePasteboard()
        let item = NSPasteboardItem()
        XCTAssertTrue(item.setString(imageURL.absoluteString, forType: .fileURL))
        XCTAssertTrue(item.setData(try XCTUnwrap(makeIcon().representation(using: .png, properties: [:])), forType: .png))
        XCTAssertTrue(pasteboard.writeObjects([item]))
        var inputs: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "image-control-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event {
                XCTAssertEqual(pasteboard.data(forType: .png), self.png)
                inputs.append(data)
            }
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

    private func makeIcon() throws -> NSBitmapImageRep {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 3, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ))
        for x in 0..<3 {
            for y in 0..<2 {
                bitmap.setColor(NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1), atX: x, y: y)
            }
        }
        return bitmap
    }
}
