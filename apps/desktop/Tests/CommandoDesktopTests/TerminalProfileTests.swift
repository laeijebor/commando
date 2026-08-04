import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class TerminalProfileTests: XCTestCase {
    func testRosePineMoonProfileMatchesXtermSettings() {
        XCTAssertEqual(TerminalProfile.preferredFontName, "JetBrains Mono")
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
}
