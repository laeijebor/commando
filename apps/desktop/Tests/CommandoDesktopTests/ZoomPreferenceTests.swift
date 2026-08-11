import XCTest
@testable import CommandoDesktop

@MainActor
final class ZoomPreferenceTests: XCTestCase {
    func testStepsMoveByTenPercentAndClampAtTheBounds() {
        XCTAssertEqual(ZoomPreference.zoomedIn(from: 100), 110)
        XCTAssertEqual(ZoomPreference.zoomedOut(from: 100), 90)

        var zoomedOut = ZoomPreference.defaultPercent
        for _ in 0..<20 { zoomedOut = ZoomPreference.zoomedOut(from: zoomedOut) }
        XCTAssertEqual(zoomedOut, ZoomPreference.minimumPercent)

        var zoomedIn = ZoomPreference.defaultPercent
        for _ in 0..<20 { zoomedIn = ZoomPreference.zoomedIn(from: zoomedIn) }
        XCTAssertEqual(zoomedIn, ZoomPreference.maximumPercent)
    }

    func testSanitizeSnapsInRangeValuesToAStepAndReplacesUnusableOnesWithTheDefault() {
        XCTAssertEqual(ZoomPreference.sanitize(120), 120)
        XCTAssertEqual(ZoomPreference.sanitize(117), 120)
        XCTAssertEqual(ZoomPreference.sanitize(112), 110)

        XCTAssertEqual(ZoomPreference.sanitize(0), ZoomPreference.defaultPercent)
        XCTAssertEqual(ZoomPreference.sanitize(-40), ZoomPreference.defaultPercent)
        XCTAssertEqual(ZoomPreference.sanitize(49), ZoomPreference.defaultPercent)
        XCTAssertEqual(ZoomPreference.sanitize(201), ZoomPreference.defaultPercent)
        XCTAssertEqual(ZoomPreference.sanitize(10_000), ZoomPreference.defaultPercent)
    }

    func testStoreRoundTripsThePercentAndDefaultsWhenAbsentOrCorrupt() throws {
        let suiteName = "CommandoDesktopTests.zoom.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsZoomPreferenceStore(defaults: defaults)

        XCTAssertEqual(store.loadZoomPercent(), ZoomPreference.defaultPercent)

        store.saveZoomPercent(130)
        XCTAssertEqual(store.loadZoomPercent(), 130)
        XCTAssertEqual(
            UserDefaultsZoomPreferenceStore(defaults: defaults).loadZoomPercent(),
            130
        )

        store.saveZoomPercent(9_000)
        XCTAssertEqual(store.loadZoomPercent(), ZoomPreference.defaultPercent)
    }
}
