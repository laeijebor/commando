import AppKit
import Foundation

private struct StoredWindowFrame: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: NSRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }

    var rect: NSRect {
        NSRect(x: x, y: y, width: width, height: height)
    }
}

private struct WindowRestorationSnapshot: Codable, Equatable, Sendable {
    let version: Int
    let frames: [StoredWindowFrame]
}

enum WindowRestorationCodec {
    static let maximumWindowCount = 8
    static let maximumStoredBytes = 64 * 1_024
    static let minimumWindowSize = NSSize(width: 760, height: 540)

    static func encode(frames: [NSRect]) -> Data? {
        let storedFrames = frames.lazy
            .filter(isFiniteUsableFrame)
            .prefix(maximumWindowCount)
            .map(StoredWindowFrame.init)
        return try? JSONEncoder().encode(WindowRestorationSnapshot(
            version: 1,
            frames: Array(storedFrames)
        ))
    }

    static func decode(_ data: Data?, visibleFrames: [NSRect]) -> [NSRect] {
        guard let data,
              data.count <= maximumStoredBytes,
              let snapshot = try? JSONDecoder().decode(WindowRestorationSnapshot.self, from: data),
              snapshot.version == 1
        else {
            return []
        }

        let screens = visibleFrames.filter(isFiniteUsableFrame)
        guard !screens.isEmpty else { return [] }
        return snapshot.frames.prefix(maximumWindowCount).compactMap { stored in
            constrain(stored.rect, to: screens)
        }
    }

    private static func isFiniteUsableFrame(_ frame: NSRect) -> Bool {
        frame.origin.x.isFinite
            && frame.origin.y.isFinite
            && frame.width.isFinite
            && frame.height.isFinite
            && frame.width > 0
            && frame.height > 0
            && abs(frame.origin.x) <= 1_000_000
            && abs(frame.origin.y) <= 1_000_000
            && frame.width <= 1_000_000
            && frame.height <= 1_000_000
    }

    private static func constrain(_ frame: NSRect, to screens: [NSRect]) -> NSRect? {
        guard isFiniteUsableFrame(frame),
              frame.width >= 100,
              frame.height >= 100
        else {
            return nil
        }
        let target = screens.max { left, right in
            intersectionArea(frame, left) < intersectionArea(frame, right)
        } ?? screens[0]
        let width = min(max(frame.width, min(minimumWindowSize.width, target.width)), target.width)
        let height = min(max(frame.height, min(minimumWindowSize.height, target.height)), target.height)
        let x = min(max(frame.minX, target.minX), target.maxX - width)
        let y = min(max(frame.minY, target.minY), target.maxY - height)
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private static func intersectionArea(_ frame: NSRect, _ screen: NSRect) -> CGFloat {
        let intersection = frame.intersection(screen)
        guard !intersection.isNull else { return 0 }
        return intersection.width * intersection.height
    }
}

@MainActor
protocol WindowRestorationStoring: AnyObject {
    func loadFrames(visibleFrames: [NSRect]) -> [NSRect]
    func saveFrames(_ frames: [NSRect])
}

@MainActor
final class UserDefaultsWindowRestorationStore: WindowRestorationStoring {
    private static let key = "CommandoDesktop.windowRestoration.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadFrames(visibleFrames: [NSRect]) -> [NSRect] {
        WindowRestorationCodec.decode(
            defaults.data(forKey: Self.key),
            visibleFrames: visibleFrames
        )
    }

    func saveFrames(_ frames: [NSRect]) {
        guard let data = WindowRestorationCodec.encode(frames: frames) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
