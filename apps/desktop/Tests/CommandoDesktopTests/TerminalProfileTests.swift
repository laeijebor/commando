import AppKit
import CryptoKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class TerminalProfileTests: XCTestCase {
    func testRosePineMoonProfileMatchesXtermSettings() {
        XCTAssertEqual(TerminalProfile.preferredFontName, "JetBrains Mono")
        XCTAssertEqual(TerminalProfile.fontNames, [
            "JetBrains Mono",
            "SFMono-Regular",
            "Cascadia Mono",
            "Menlo",
            "Consolas",
            "Liberation Mono",
        ])
        XCTAssertEqual(TerminalProfile.fontSize, 10)
        XCTAssertEqual(TerminalProfile.backgroundHex, 0x232136)
        XCTAssertEqual(TerminalProfile.foregroundHex, 0xe0def4)
        XCTAssertEqual(TerminalProfile.cursorHex, 0xe0def4)
        XCTAssertEqual(TerminalProfile.cursorTextHex, 0x232136)
        XCTAssertEqual(TerminalProfile.selectionBackgroundHex, 0x44415a)
        XCTAssertEqual(TerminalProfile.selectionForegroundHex, 0xe0def4)
        XCTAssertEqual(TerminalProfile.ansiHex, [
            0x393552, 0xeb6f92, 0x3e8fb0, 0xf6c177,
            0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
            0x6e6a86, 0xeb6f92, 0x3e8fb0, 0xf6c177,
            0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
        ])
    }

    func testSurfaceAppliesFontAndNativeColors() {
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "profile"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            eventSink: { _ in }
        )

        XCTAssertEqual(surface.view.font.fontName, TerminalProfile.font().fontName)
        XCTAssertEqual(surface.view.font.pointSize, TerminalProfile.fontSize)
        XCTAssertEqual(surface.view.nativeBackgroundColor, TerminalProfile.backgroundColor)
        XCTAssertEqual(surface.view.nativeForegroundColor, TerminalProfile.foregroundColor)
        surface.destroy()
    }

    func testBundledJetBrainsMonoResourcesExistAndMatchProvenance() throws {
        let fontURL = try XCTUnwrap(BundledTerminalFont.resourceURL)
        let boldFontURL = try XCTUnwrap(BundledTerminalFont.boldResourceURL)
        let licenseURL = try XCTUnwrap(BundledTerminalFont.licenseURL)
        let provenanceURL = try XCTUnwrap(BundledTerminalFont.provenanceURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: fontURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: boldFontURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: licenseURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: provenanceURL.path))

        let regularDigest = SHA256.hash(data: try Data(contentsOf: fontURL))
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(regularDigest, BundledTerminalFont.expectedSHA256)
        let boldDigest = SHA256.hash(data: try Data(contentsOf: boldFontURL))
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(boldDigest, BundledTerminalFont.expectedBoldSHA256)

        let license = try String(contentsOf: licenseURL, encoding: .utf8)
        XCTAssertTrue(license.contains("SIL OPEN FONT LICENSE Version 1.1"))

        let provenance = try String(contentsOf: provenanceURL, encoding: .utf8)
        XCTAssertTrue(provenance.contains("@fontsource/jetbrains-mono@5.2.8"))
        XCTAssertTrue(provenance.contains("version `v24`"))
        XCTAssertTrue(provenance.contains(BundledTerminalFont.expectedSHA256))
        XCTAssertTrue(provenance.contains(BundledTerminalFont.expectedBoldSHA256))
    }

    func testBundledRegistrationProvidesRegularAndBoldFromResource() throws {
        XCTAssertTrue(
            BundledTerminalFont.register(),
            BundledTerminalFont.registrationFailure ?? "registration failed"
        )
        let resourceURL = try XCTUnwrap(BundledTerminalFont.resourceURL).standardizedFileURL
        let boldResourceURL = try XCTUnwrap(
            BundledTerminalFont.boldResourceURL
        ).standardizedFileURL

        let regular = try XCTUnwrap(BundledTerminalFont.font(size: 10, face: .regular))
        XCTAssertEqual(regular.fontName, "JetBrainsMono-Regular")
        XCTAssertEqual(
            BundledTerminalFont.sourceURL(for: regular)?.standardizedFileURL,
            resourceURL
        )

        let bold = try XCTUnwrap(BundledTerminalFont.font(size: 10, face: .bold))
        XCTAssertEqual(bold.fontName, "JetBrainsMono-Bold")
        XCTAssertEqual(
            BundledTerminalFont.sourceURL(for: bold)?.standardizedFileURL,
            boldResourceURL
        )

        let swiftTermBold = NSFontManager.shared.convert(regular, toHaveTrait: .boldFontMask)
        XCTAssertEqual(swiftTermBold.fontName, "JetBrainsMono-Bold")
        XCTAssertEqual(
            BundledTerminalFont.sourceURL(for: swiftTermBold)?.standardizedFileURL,
            boldResourceURL
        )
    }

    func testProfileSelectsBundledFontInsteadOfGlobalNameLookup() throws {
        let resourceURL = try XCTUnwrap(BundledTerminalFont.resourceURL).standardizedFileURL
        let font = TerminalProfile.font()

        XCTAssertEqual(font.fontName, "JetBrainsMono-Regular")
        XCTAssertEqual(
            BundledTerminalFont.sourceURL(for: font)?.standardizedFileURL,
            resourceURL
        )
    }
}
