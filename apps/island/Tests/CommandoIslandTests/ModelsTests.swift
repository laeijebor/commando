import Foundation
import Testing
@testable import CommandoIsland

@Test func decodesCompanionSnapshotWithOriginNamesAndUsage() throws {
    let payload = #"""
    {
      "type": "companion_snapshot",
      "snapshot": {
        "revision": 7,
        "capturedAt": 1000,
        "sessions": [{
          "id": "$1:%2",
          "tmuxSessionId": "$1",
          "tmuxSessionName": "commando",
          "agentSessionId": "ses_123",
          "agentSessionName": "Build the island",
          "provider": "opencode",
          "status": "needs_input",
          "summary": "Choose a target",
          "lastOutput": "Building companion\nWaiting for selection",
          "requests": [{
            "id": "question-1",
            "kind": "question",
            "prompt": "Which target?",
            "questions": [{
              "header": "Target",
              "question": "Which target?",
              "options": [{"label": "macOS", "description": "Native app"}],
              "multiple": false,
              "custom": false
            }],
            "createdAt": 900
          }],
          "paneId": "%2",
          "paneIndex": 1,
          "updatedAt": 950
        }],
        "usage": [{
          "provider": "claude",
          "state": "available",
          "windows": [{
            "label": "5h",
            "usedPercent": 25,
            "remainingPercent": 75,
            "resetsAt": 2000
          }],
          "updatedAt": 1000
        }]
      }
    }
    """#

    let envelope = try JSONDecoder().decode(CompanionEnvelope.self, from: Data(payload.utf8))

    #expect(envelope.snapshot?.primarySession?.tmuxSessionName == "commando")
    #expect(envelope.snapshot?.primarySession?.agentSessionName == "Build the island")
    #expect(envelope.snapshot?.primarySession?.lastOutput == "Building companion\nWaiting for selection")
    #expect(envelope.snapshot?.primarySession?.requests.first?.questions?.first?.options.first?.label == "macOS")
    #expect(envelope.snapshot?.usage.first?.windows.first?.remainingPercent == 75)
}

@Test func encodesPermissionAndQuestionAnswers() throws {
    let permission = CompanionCommand.answer(
        paneId: "%1",
        requestId: "permission-1",
        action: "allow_once"
    )
    let question = CompanionCommand.answer(
        paneId: "%2",
        requestId: "question-1",
        action: "answer",
        answers: [["Production"], ["Tests", "Typecheck"]]
    )
    let focus = CompanionCommand.focusOutput(paneId: "%2")

    let permissionJSON = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(permission)) as? [String: Any]
    )
    let questionJSON = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(question)) as? [String: Any]
    )
    let focusJSON = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(focus)) as? [String: Any]
    )

    #expect(permissionJSON["paneId"] as? String == "%1")
    #expect((permissionJSON["answer"] as? [String: Any])?["action"] as? String == "allow_once")
    #expect((questionJSON["answer"] as? [String: Any])?["answers"] as? [[String]] == [
        ["Production"],
        ["Tests", "Typecheck"],
    ])
    #expect(focusJSON["type"] as? String == "focus_output")
    #expect(focusJSON["paneId"] as? String == "%2")
}

@Test func placesBothIslandSizesAtTheScreenTopCenter() {
    let screen = CGRect(x: 100, y: 50, width: 1_600, height: 1_000)
    let compact = IslandGeometry.frame(screenFrame: screen, expanded: false)
    let expanded = IslandGeometry.frame(screenFrame: screen, expanded: true)

    #expect(compact.midX == screen.midX)
    #expect(expanded.midX == screen.midX)
    #expect(compact.maxY == screen.maxY)
    #expect(expanded.maxY == screen.maxY)
    #expect(compact.size == IslandGeometry.baseCompactSize)
    #expect(expanded.size == IslandGeometry.expandedSize)
}

@Test func reservesTheBuiltInDisplayCameraGap() {
    let display = IslandGeometry.displayLayout(
        leftAuxiliaryArea: CGRect(x: 0, y: 1_878, width: 1_336, height: 56),
        rightAuxiliaryArea: CGRect(x: 1_656, y: 1_878, width: 1_336, height: 56),
        safeAreaTop: 56
    )

    #expect(display.cameraGapWidth == 344)
    #expect(display.compactSize == CGSize(width: 796, height: 56))
}

@Test func keepsStandardLayoutWhenDisplayHasNoCameraGap() {
    let display = IslandGeometry.displayLayout(
        leftAuxiliaryArea: nil,
        rightAuxiliaryArea: nil,
        safeAreaTop: 24
    )

    #expect(display == .standard)
}

@Test func keepsExpandedIslandAtLeastAsWideAsNotchedCompactIsland() {
    let screen = CGRect(x: 0, y: 0, width: 2_992, height: 1_934)
    let display = IslandGeometry.displayLayout(
        leftAuxiliaryArea: CGRect(x: 0, y: 1_878, width: 1_336, height: 56),
        rightAuxiliaryArea: CGRect(x: 1_656, y: 1_878, width: 1_336, height: 56),
        safeAreaTop: 56
    )
    let expanded = IslandGeometry.frame(
        screenFrame: screen,
        expanded: true,
        displayLayout: display
    )

    #expect(expanded.midX == screen.midX)
    #expect(expanded.maxY == screen.maxY)
    #expect(expanded.size == CGSize(width: 796, height: 540))
}

@Test func resolvesPreferredCurrentAndPointerDisplaysInOrder() {
    let displays = [
        IslandScreenDescriptor(key: "built-in", frame: CGRect(x: 0, y: 0, width: 1_000, height: 800)),
        IslandScreenDescriptor(key: "external", frame: CGRect(x: 1_000, y: 0, width: 1_000, height: 800)),
    ]

    #expect(IslandScreenSelection.targetDisplayKey(
        displays: displays,
        preferredDisplayKey: "external",
        currentDisplayKey: "built-in",
        pointerLocation: CGPoint(x: 100, y: 100)
    ) == "external")
    #expect(IslandScreenSelection.targetDisplayKey(
        displays: displays,
        preferredDisplayKey: "disconnected",
        currentDisplayKey: "built-in",
        pointerLocation: CGPoint(x: 1_100, y: 100)
    ) == "built-in")
    #expect(IslandScreenSelection.targetDisplayKey(
        displays: displays,
        preferredDisplayKey: nil,
        currentDisplayKey: nil,
        pointerLocation: CGPoint(x: 1_100, y: 100)
    ) == "external")
    #expect(IslandScreenSelection.targetDisplayKey(
        displays: displays,
        preferredDisplayKey: nil,
        currentDisplayKey: nil,
        pointerLocation: CGPoint(x: 3_000, y: 100)
    ) == "built-in")
}

@Test @MainActor func hoverReentryCancelsScheduledCollapse() async throws {
    let store = CompanionStore()
    store.configureHoverTracking(
        panelFrame: { CGRect(x: 0, y: 0, width: 100, height: 100) },
        pointerLocation: { CGPoint(x: 150, y: 150) },
        collapseDelay: .milliseconds(10)
    )
    store.isExpanded = true

    store.hoverChanged(inside: false)
    store.hoverChanged(inside: true)
    try await Task.sleep(for: .milliseconds(30))

    #expect(store.isExpanded)
}

@Test @MainActor func hoverExitKeepsPanelOpenWhenPointerIsInsideFinalFrame() async throws {
    let store = CompanionStore()
    var frame = CGRect(x: 0, y: 0, width: 100, height: 100)
    store.configureHoverTracking(
        panelFrame: { frame },
        pointerLocation: { CGPoint(x: 150, y: 50) },
        collapseDelay: .milliseconds(10)
    )
    store.isExpanded = true

    store.hoverChanged(inside: false)
    frame = CGRect(x: 0, y: 0, width: 200, height: 100)
    try await Task.sleep(for: .milliseconds(30))

    #expect(store.isExpanded)
}

@Test @MainActor func hoverExitCollapsesPanelWhenPointerRemainsOutside() async throws {
    let store = CompanionStore()
    store.configureHoverTracking(
        panelFrame: { CGRect(x: 0, y: 0, width: 100, height: 100) },
        pointerLocation: { CGPoint(x: 150, y: 150) },
        collapseDelay: .milliseconds(10)
    )
    store.isExpanded = true

    store.hoverChanged(inside: false)
    try await Task.sleep(for: .milliseconds(30))

    #expect(!store.isExpanded)
}
