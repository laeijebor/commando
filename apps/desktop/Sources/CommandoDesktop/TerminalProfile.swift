import AppKit
import SwiftTerm

enum TerminalProfile {
    static let preferredFontName = "JetBrains Mono"
    static let fontNames = [
        preferredFontName,
        "SFMono-Regular",
        "Cascadia Mono",
        "Menlo",
        "Consolas",
        "Liberation Mono",
    ]
    static let fontSize: CGFloat = 10

    static let backgroundHex: UInt32 = 0x232136
    static let foregroundHex: UInt32 = 0xe0def4
    static let cursorHex: UInt32 = 0xe0def4
    static let cursorTextHex: UInt32 = 0x232136
    static let selectionBackgroundHex: UInt32 = 0x44415a
    static let selectionForegroundHex: UInt32 = 0xe0def4

    static let ansiHex: [UInt32] = [
        0x393552, 0xeb6f92, 0x3e8fb0, 0xf6c177,
        0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
        0x6e6a86, 0xeb6f92, 0x3e8fb0, 0xf6c177,
        0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
    ]

    static var backgroundColor: NSColor { nativeColor(backgroundHex) }
    static var foregroundColor: NSColor { nativeColor(foregroundHex) }

    @MainActor
    static func apply(to view: TerminalView) {
        let terminal = view.getTerminal()
        terminal.ansi256PaletteStrategy = .xterm

        view.font = font()
        view.nativeBackgroundColor = backgroundColor
        view.nativeForegroundColor = foregroundColor
        view.caretColor = nativeColor(cursorHex)
        view.caretTextColor = nativeColor(cursorTextHex)
        view.selectedTextBackgroundColor = nativeColor(selectionBackgroundHex)
        view.selectedTextForegroundColor = nativeColor(selectionForegroundHex)
        view.installColors(ansiHex.map(terminalColor))
        view.layer?.backgroundColor = backgroundColor.cgColor
    }

    static func font() -> NSFont {
        for name in fontNames {
            if let font = NSFont(name: name, size: fontSize) {
                return font
            }
        }
        return NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    }

    private static func nativeColor(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }

    private static func terminalColor(_ hex: UInt32) -> Color {
        Color(
            red: UInt16((hex >> 16) & 0xff) * 257,
            green: UInt16((hex >> 8) & 0xff) * 257,
            blue: UInt16(hex & 0xff) * 257
        )
    }
}
