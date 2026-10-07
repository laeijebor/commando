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

    @MainActor static var palette = TerminalPalette.rosePineMoon

    @MainActor static var backgroundColor: NSColor { nativeColor(palette.background) }
    @MainActor static var foregroundColor: NSColor { nativeColor(palette.foreground) }

    @MainActor
    static func apply(to view: TerminalView) {
        view.getTerminal().ansi256PaletteStrategy = .xterm
        view.font = font()
        applyColors(to: view)
    }

    @MainActor
    static func applyColors(to view: TerminalView) {
        view.nativeBackgroundColor = backgroundColor
        view.nativeForegroundColor = foregroundColor
        view.caretColor = nativeColor(palette.cursor)
        view.caretTextColor = nativeColor(palette.cursorText)
        view.selectedTextBackgroundColor = nativeColor(palette.selectionBackground)
        view.selectedTextForegroundColor = nativeColor(palette.selectionForeground)
        view.installColors(palette.ansi.map(terminalColor))
        view.layer?.backgroundColor = backgroundColor.cgColor
    }

    @MainActor
    static func font(size: CGFloat = fontSize) -> NSFont {
        if let bundledFont = BundledTerminalFont.font(size: size) {
            return bundledFont
        }
        for name in fontNames {
            if let font = NSFont(name: name, size: size) {
                return font
            }
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
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

/// Terminal colors as 0xRRGGBB values; the web page sends the active theme's palette.
struct TerminalPalette: Equatable, Sendable {
    static let ansiCount = 16

    let background: UInt32
    let foreground: UInt32
    let cursor: UInt32
    let cursorText: UInt32
    let selectionBackground: UInt32
    let selectionForeground: UInt32
    let ansi: [UInt32]

    static let rosePineMoon = TerminalPalette(
        background: 0x232136,
        foreground: 0xe0def4,
        cursor: 0xe0def4,
        cursorText: 0x232136,
        selectionBackground: 0x44415a,
        selectionForeground: 0xe0def4,
        ansi: [
            0x393552, 0xeb6f92, 0x3e8fb0, 0xf6c177,
            0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
            0x6e6a86, 0xeb6f92, 0x3e8fb0, 0xf6c177,
            0x9ccfd8, 0xc4a7e7, 0xea9a97, 0xe0def4,
        ]
    )
}
