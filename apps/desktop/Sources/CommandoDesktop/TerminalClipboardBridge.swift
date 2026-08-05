import AppKit

enum TerminalClipboardBridgeResult: Equatable {
    case unchanged
    case addedPNG
    case unavailable
}

@MainActor
enum TerminalClipboardBridge {
    static let maxConvertedPNGBytes = 32 * 1_024 * 1_024

    static func boundedPlainText(in pasteboard: NSPasteboard) -> String? {
        guard let text = pasteboard.string(forType: .string),
              !text.isEmpty,
              !text.utf8.contains(0),
              text.utf8.count <= NativeTerminalProtocol.maxPasteBytes
        else {
            return nil
        }
        return text
    }

    static func writePlainText(_ text: String, to pasteboard: NSPasteboard) -> Bool {
        guard !text.isEmpty else { return false }
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }

    static func ensurePNGRepresentation(in pasteboard: NSPasteboard) -> TerminalClipboardBridgeResult {
        if let png = pasteboard.data(forType: .png), !png.isEmpty {
            return .unchanged
        }
        guard NSImage.canInit(with: pasteboard),
              let image = NSImage(pasteboard: pasteboard),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]),
              !png.isEmpty,
              png.count <= maxConvertedPNGBytes,
              let originalItems = pasteboard.pasteboardItems,
              !originalItems.isEmpty
        else {
            return .unavailable
        }

        let copiedItems = originalItems.map { original in
            let copy = NSPasteboardItem()
            for type in original.types {
                if let data = original.data(forType: type) {
                    copy.setData(data, forType: type)
                } else if let propertyList = original.propertyList(forType: type) {
                    copy.setPropertyList(propertyList, forType: type)
                } else if let string = original.string(forType: type) {
                    copy.setString(string, forType: type)
                }
            }
            return copy
        }
        guard copiedItems[0].setData(png, forType: .png) else { return .unavailable }

        pasteboard.clearContents()
        return pasteboard.writeObjects(copiedItems) ? .addedPNG : .unavailable
    }
}
