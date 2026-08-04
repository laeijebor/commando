import CoreGraphics
import Foundation

struct TerminalPlacement: Equatable, Sendable {
    let frame: CGRect
    let isHidden: Bool
}

enum TerminalGeometry {
    static func placement(
        for payload: PaneFramePayload,
        viewportSize: CGSize,
        backingScale: CGFloat,
        contentScale: CGFloat = 1
    ) -> TerminalPlacement {
        guard payload.visible,
              viewportSize.width > 0,
              viewportSize.height > 0,
              backingScale.isFinite,
              backingScale > 0,
              contentScale.isFinite,
              contentScale > 0
        else {
            return hiddenPlacement
        }

        let pointsPerCSSPixel = CGFloat(payload.scale) / backingScale * contentScale
        let values = [payload.x, payload.y, payload.width, payload.height].map {
            CGFloat($0) * pointsPerCSSPixel
        }
        guard values.allSatisfy(\.isFinite) else { return hiddenPlacement }

        let cssFrame = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        let topLeftViewport = CGRect(origin: .zero, size: viewportSize)
        guard cssFrame.width > 0,
              cssFrame.height > 0,
              topLeftViewport.contains(cssFrame)
        else {
            return hiddenPlacement
        }

        return TerminalPlacement(
            frame: CGRect(
                x: cssFrame.minX,
                y: viewportSize.height - cssFrame.maxY,
                width: cssFrame.width,
                height: cssFrame.height
            ),
            isHidden: false
        )
    }

    private static let hiddenPlacement = TerminalPlacement(frame: .zero, isHidden: true)
}

struct ResizeEmissionGate: Equatable, Sendable {
    private(set) var lastEmitted: GridSize?

    mutating func reset() {
        lastEmitted = nil
    }

    mutating func shouldEmit(
        cols: Int,
        rows: Int,
        isVisible: Bool,
        isResizeOwner: Bool
    ) -> Bool {
        guard isVisible, isResizeOwner else {
            reset()
            return false
        }
        guard (NativeTerminalProtocol.minCols...NativeTerminalProtocol.maxCols).contains(cols),
              (NativeTerminalProtocol.minRows...NativeTerminalProtocol.maxRows).contains(rows)
        else {
            return false
        }
        let size = GridSize(cols: cols, rows: rows)
        guard size != lastEmitted else { return false }
        lastEmitted = size
        return true
    }
}

struct GridSize: Equatable, Sendable {
    let cols: Int
    let rows: Int
}

struct SurfaceOrderKey: Comparable, Equatable, Sendable {
    let order: Int
    let paneId: String
    let attachmentId: String

    static func < (lhs: SurfaceOrderKey, rhs: SurfaceOrderKey) -> Bool {
        if lhs.order != rhs.order { return lhs.order < rhs.order }
        if lhs.paneId != rhs.paneId { return lhs.paneId < rhs.paneId }
        return lhs.attachmentId < rhs.attachmentId
    }
}
