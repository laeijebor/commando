import CoreGraphics
import Foundation

struct TerminalPlacement: Equatable, Sendable {
    let frame: CGRect
    let visibleFrames: [CGRect]
    let isHidden: Bool
}

enum TerminalGeometry {
    static let maxViewportDimension: CGFloat = 16_384
    static let minBackingScale: CGFloat = 0.5
    static let maxBackingScale: CGFloat = 8
    static let minContentScale: CGFloat = 0.25
    static let maxContentScale: CGFloat = 4
    private static let maxPointsPerCSSPixel = 16.0
    private static let maxDerivedCoordinate = 1_000_000.0
    private static let maxDerivedDimension = 131_072.0

    static func clientPoint(
        for normalizedPoint: CGPoint,
        in payload: PaneFramePayload
    ) -> CGPoint? {
        guard normalizedPoint.x.isFinite,
              normalizedPoint.y.isFinite,
              (0...1).contains(normalizedPoint.x),
              (0...1).contains(normalizedPoint.y),
              NativeTerminalProtocol.isValidFrameCoordinate(payload.x),
              NativeTerminalProtocol.isValidFrameCoordinate(payload.y),
              NativeTerminalProtocol.isValidFrameDimension(payload.width, allowsZero: false),
              NativeTerminalProtocol.isValidFrameDimension(payload.height, allowsZero: false)
        else {
            return nil
        }
        let x = payload.x + Double(normalizedPoint.x) * payload.width
        let y = payload.y + Double(normalizedPoint.y) * payload.height
        guard x.isFinite, y.isFinite,
              abs(x) <= NativeTerminalProtocol.maxFrameCoordinate + NativeTerminalProtocol.maxFrameDimension,
              abs(y) <= NativeTerminalProtocol.maxFrameCoordinate + NativeTerminalProtocol.maxFrameDimension
        else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }

    static func placement(
        for payload: PaneFramePayload,
        viewportSize: CGSize,
        backingScale: CGFloat
    ) -> TerminalPlacement {
        guard payload.visible,
               viewportSize.width > 0,
               viewportSize.height > 0,
               viewportSize.width <= maxViewportDimension,
               viewportSize.height <= maxViewportDimension,
               viewportSize.width.isFinite,
               viewportSize.height.isFinite,
               backingScale.isFinite,
               (minBackingScale...maxBackingScale).contains(backingScale),
               NativeTerminalProtocol.isValidFrameCoordinate(payload.x),
               NativeTerminalProtocol.isValidFrameCoordinate(payload.y),
               NativeTerminalProtocol.isValidFrameDimension(payload.width, allowsZero: true),
               NativeTerminalProtocol.isValidFrameDimension(payload.height, allowsZero: true),
               NativeTerminalProtocol.isValidFrameScale(payload.scale),
               payload.visibleRegions.allSatisfy({ region in
                   NativeTerminalProtocol.isValidFrameCoordinate(region.x) &&
                       NativeTerminalProtocol.isValidFrameCoordinate(region.y) &&
                       NativeTerminalProtocol.isValidFrameDimension(region.width, allowsZero: false) &&
                       NativeTerminalProtocol.isValidFrameDimension(region.height, allowsZero: false)
               })
        else {
            return hiddenPlacement
        }

        let pointsPerCSSPixel = payload.scale / Double(backingScale)
        guard pointsPerCSSPixel.isFinite,
              pointsPerCSSPixel > 0,
              pointsPerCSSPixel <= maxPointsPerCSSPixel
        else {
            return hiddenPlacement
        }
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
        scale: Double
    ) -> CGRect? {
        let values = [x, y, width, height].map { $0 * scale }
        guard values.allSatisfy(\.isFinite),
              abs(values[0]) <= maxDerivedCoordinate,
              abs(values[1]) <= maxDerivedCoordinate,
              values[2] >= 0,
              values[3] >= 0,
              values[2] <= maxDerivedDimension,
              values[3] <= maxDerivedDimension
        else {
            return nil
        }
        return CGRect(
            x: CGFloat(values[0]),
            y: CGFloat(values[1]),
            width: CGFloat(values[2]),
            height: CGFloat(values[3])
        )
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
    static func frame(
        viewport: CGRect,
        sourceContentSize: CGSize,
        resizeOwner: Bool,
        maximumSurfaceSize: CGSize = .init(width: 16_384, height: 16_384),
        scrollOffset: CGPoint = .zero
    ) -> CGRect {
        guard isValid(viewport.size),
              isValid(sourceContentSize),
              isValid(maximumSurfaceSize),
              viewport.origin.x.isFinite,
              viewport.origin.y.isFinite
        else {
            return .zero
        }
        let viewportSize = CGSize(
            width: min(viewport.width, maximumSurfaceSize.width),
            height: min(viewport.height, maximumSurfaceSize.height)
        )
        let surfaceSize = resizeOwner ? viewportSize : CGSize(
            width: min(max(viewportSize.width, sourceContentSize.width), maximumSurfaceSize.width),
            height: min(max(viewportSize.height, sourceContentSize.height), maximumSurfaceSize.height)
        )
        let offset = resizeOwner ? CGPoint.zero : clampedOffset(
            scrollOffset,
            viewportSize: viewportSize,
            surfaceSize: surfaceSize
        )
        return CGRect(
            x: viewport.minX - offset.x,
            y: viewport.maxY - surfaceSize.height + offset.y,
            width: surfaceSize.width,
            height: surfaceSize.height
        )
    }

    static func clampedOffset(
        _ offset: CGPoint,
        viewportSize: CGSize,
        surfaceSize: CGSize
    ) -> CGPoint {
        guard offset.x.isFinite, offset.y.isFinite,
              isValid(viewportSize), isValid(surfaceSize)
        else {
            return .zero
        }
        return CGPoint(
            x: min(max(0, offset.x), max(0, surfaceSize.width - viewportSize.width)),
            y: min(max(0, offset.y), max(0, surfaceSize.height - viewportSize.height))
        )
    }

    private static func isValid(_ size: CGSize) -> Bool {
        size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0
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
