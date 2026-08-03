import XCTest
@testable import CommandoDesktop

final class OrderGateTests: XCTestCase {
    func testSequenceGateRequiresConnectAndStrictlyIncreasingSequence() {
        var gate = BridgeSequenceGate()
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-a", sequence: 0)), .rejected(code: "bridge_not_connected"))
        XCTAssertEqual(gate.accept(connectEnvelope(pageId: "page-a", sequence: 4)), .connected(replacedPage: false))
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-a", sequence: 5)), .accepted)
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-a", sequence: 5)), .rejected(code: "stale_sequence"))
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-a", sequence: 3)), .rejected(code: "stale_sequence"))
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-b", sequence: 6)), .rejected(code: "stale_page"))
    }

    func testNewPageConnectResetsSequenceAndPageResetRequiresReconnect() {
        var gate = BridgeSequenceGate()
        XCTAssertEqual(gate.accept(connectEnvelope(pageId: "page-a", sequence: 50)), .connected(replacedPage: false))
        XCTAssertEqual(gate.accept(connectEnvelope(pageId: "page-b", sequence: 0)), .connected(replacedPage: true))
        XCTAssertEqual(gate.pageId, "page-b")
        XCTAssertEqual(gate.lastSequence, 0)

        gate.reset()
        XCTAssertNil(gate.pageId)
        XCTAssertNil(gate.lastSequence)
        XCTAssertEqual(gate.accept(dataEnvelope(pageId: "page-b", sequence: 1)), .rejected(code: "bridge_not_connected"))
    }

    func testEachSurfaceHasAnIndependentRevisionGate() {
        var first = TerminalDataOrderGate()
        var second = TerminalDataOrderGate()

        XCTAssertTrue(first.acceptReset(revision: 10))
        XCTAssertTrue(second.acceptReset(revision: 2))
        XCTAssertTrue(first.acceptData(revision: 11))
        XCTAssertFalse(first.acceptData(revision: 11))
        XCTAssertTrue(second.acceptData(revision: 3))
        XCTAssertEqual(first.revision, 11)
        XCTAssertEqual(second.revision, 3)
    }

    func testResetIsAuthoritativeAndRebasesRevision() {
        var gate = TerminalDataOrderGate()
        XCTAssertTrue(gate.acceptReset(revision: 20))
        XCTAssertTrue(gate.acceptData(revision: 21))
        XCTAssertTrue(gate.acceptReset(revision: 1))
        XCTAssertFalse(gate.acceptData(revision: 1))
        XCTAssertTrue(gate.acceptData(revision: 2))
    }

    private func connectEnvelope(pageId: String, sequence: Int) -> NativeTerminalEnvelope {
        .init(
            pageId: pageId,
            sequence: sequence,
            command: .connect(.init(supportedVersions: [1]))
        )
    }

    private func dataEnvelope(pageId: String, sequence: Int) -> NativeTerminalEnvelope {
        .init(
            pageId: pageId,
            sequence: sequence,
            command: .data(.init(
                identity: .init(paneId: "%1", attachmentId: "a"),
                data: Data(),
                revision: sequence
            ))
        )
    }
}
