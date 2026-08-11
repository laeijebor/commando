import Foundation

enum ZoomPreference {
    static let minimumPercent = 50
    static let maximumPercent = 200
    static let stepPercent = 10
    static let defaultPercent = 100

    /// Normalizes a percent that came from storage. In-range values snap to the
    /// nearest step; anything outside the supported range is unusable and falls
    /// back to 100% rather than being clamped, so a corrupt value cannot leave
    /// the app stuck at its smallest or largest zoom.
    static func sanitize(_ percent: Int) -> Int {
        guard percent >= minimumPercent, percent <= maximumPercent else {
            return defaultPercent
        }
        return Int((Double(percent) / Double(stepPercent)).rounded()) * stepPercent
    }

    static func zoomedIn(from percent: Int) -> Int {
        min(maximumPercent, sanitize(percent) + stepPercent)
    }

    static func zoomedOut(from percent: Int) -> Int {
        max(minimumPercent, sanitize(percent) - stepPercent)
    }
}

@MainActor
protocol ZoomPreferenceStoring: AnyObject {
    func loadZoomPercent() -> Int
    func saveZoomPercent(_ percent: Int)
}

@MainActor
final class UserDefaultsZoomPreferenceStore: ZoomPreferenceStoring {
    private static let key = "CommandoDesktop.zoomPercent.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadZoomPercent() -> Int {
        guard defaults.object(forKey: Self.key) != nil else { return ZoomPreference.defaultPercent }
        return ZoomPreference.sanitize(defaults.integer(forKey: Self.key))
    }

    func saveZoomPercent(_ percent: Int) {
        defaults.set(percent, forKey: Self.key)
    }
}
