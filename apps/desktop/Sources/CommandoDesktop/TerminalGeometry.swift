import CoreGraphics
import Foundation

struct TerminalPlacement: Equatable, Sendable {
    let frame: CGRect
    let visibleFrames: [CGRect]
    let isHidden: Bool
}

enum TerminalGeometry {
    static func clientPoint(
        for normalizedPoint: CGPoint,
        in payload: PaneFramePayload
    ) -> CGPoint? {
        guard normalizedPoint.x.isFinite,
              normalizedPoint.y.isFinite,
              (0...1).contains(normalizedPoint.x),
              (0...1).contains(normalizedPoint.y),
              payload.x.isFinite,
              payload.y.isFinite,
              payload.width > 0,
              payload.height > 0
        else {
            return nil
        }
        return CGPoint(
            x: payload.x + Double(normalizedPoint.x) * payload.width,
            y: payload.y + Double(normalizedPoint.y) * payload.height
        )
    }

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
        guard let topLeftFrame = scaledRect(
            x: payload.x,
            y: payload.y,
            width: payload.width,
            height: payload.height,
            scale: pointsPerCSSPixel
        ) else {
            return hiddenPlacement
        }
        let topLeftViewport = CGRect(origin: .zero, size: viewportSize)
        guard topLeftFrame.width > 0, topLeftFrame.height > 0 else {
            return hiddenPlacement
        }

        let visibleFrames = payload.visibleRegions.compactMap { region -> CGRect? in
            guard let topLeftRegion = scaledRect(
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                scale: pointsPerCSSPixel
            ) else {
                return nil
            }
            let clipped = topLeftRegion.intersection(topLeftFrame).intersection(topLeftViewport)
            guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
            return appKitFrame(fromTopLeft: clipped, viewportHeight: viewportSize.height)
        }
        guard !visibleFrames.isEmpty else { return hiddenPlacement }

        return TerminalPlacement(
            frame: appKitFrame(fromTopLeft: topLeftFrame, viewportHeight: viewportSize.height),
            visibleFrames: visibleFrames,
            isHidden: false
        )
    }

    private static func scaledRect(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        scale: CGFloat
    ) -> CGRect? {
        let values = [x, y, width, height].map { CGFloat($0) * scale }
        guard values.allSatisfy(\.isFinite) else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }

    private static func appKitFrame(fromTopLeft frame: CGRect, viewportHeight: CGFloat) -> CGRect {
        CGRect(
            x: frame.minX,
            y: viewportHeight - frame.maxY,
            width: frame.width,
            height: frame.height
        )
    }

    private static let hiddenPlacement = TerminalPlacement(
        frame: .zero,
        visibleFrames: [],
        isHidden: true
    )
}

enum TerminalSourceGridLayout {
    static func frame(viewport: CGRect, sourceContentSize: CGSize, resizeOwner: Bool) -> CGRect {
        guard !resizeOwner else { return viewport }
        let width = max(viewport.width, sourceContentSize.width)
        let height = max(viewport.height, sourceContentSize.height)
        return CGRect(x: viewport.minX, y: viewport.maxY - height, width: width, height: height)
    }
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
