import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
final class DesktopApplicationTests: XCTestCase {
    func testMainMenuIdentifiesCommandoAndProvidesClipboardActions() throws {
        let menu = DesktopMainMenu.make()

        XCTAssertEqual(menu.items.map(\.title), ["Commando", "Edit"])
        let applicationMenu = try XCTUnwrap(menu.items[0].submenu)
        XCTAssertEqual(applicationMenu.items.first?.title, "About Commando")
        XCTAssertEqual(applicationMenu.items.last?.title, "Quit Commando")
        let editMenu = try XCTUnwrap(menu.items[1].submenu)
        XCTAssertEqual(editMenu.items.map(\.title), ["Copy", "Paste"])
    }
}
