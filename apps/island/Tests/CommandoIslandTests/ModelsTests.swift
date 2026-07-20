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

    let permissionJSON = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(permission)) as? [String: Any]
    )
    let questionJSON = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(question)) as? [String: Any]
    )

    #expect(permissionJSON["paneId"] as? String == "%1")
    #expect((permissionJSON["answer"] as? [String: Any])?["action"] as? String == "allow_once")
    #expect((questionJSON["answer"] as? [String: Any])?["answers"] as? [[String]] == [
        ["Production"],
        ["Tests", "Typecheck"],
    ])
}

@Test func placesBothIslandSizesAtTheScreenTopCenter() {
    let screen = CGRect(x: 100, y: 50, width: 1_600, height: 1_000)
    let compact = IslandGeometry.frame(screenFrame: screen, expanded: false)
    let expanded = IslandGeometry.frame(screenFrame: screen, expanded: true)

    #expect(compact.midX == screen.midX)
    #expect(expanded.midX == screen.midX)
    #expect(compact.maxY == screen.maxY)
    #expect(expanded.maxY == screen.maxY)
    #expect(compact.size == IslandGeometry.compactSize)
    #expect(expanded.size == IslandGeometry.expandedSize)
}
