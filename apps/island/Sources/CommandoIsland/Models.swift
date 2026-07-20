import Foundation

enum AgentProvider: String, Codable, Sendable {
    case claude
    case codex
    case opencode
    case unknown

    var displayName: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        case .unknown: "Agent"
        }
    }
}

enum AgentStatusKind: String, Codable, Sendable {
    case working
    case needsInput = "needs_input"
    case done
    case failed
    case stale
    case unknown

    var displayName: String {
        switch self {
        case .working: "Working"
        case .needsInput: "Needs you"
        case .done: "Done"
        case .failed: "Failed"
        case .stale: "Stale"
        case .unknown: "Idle"
        }
    }
}

struct AgentActivity: Codable, Equatable, Sendable {
    let label: String
    let kind: String
    let state: String
    let updatedAt: Double
}

struct AgentQuestionOption: Codable, Equatable, Identifiable, Sendable {
    let label: String
    let description: String?

    var id: String { label }
}

struct AgentQuestion: Codable, Equatable, Sendable {
    let header: String
    let question: String
    let options: [AgentQuestionOption]
    let multiple: Bool
    let custom: Bool
}

enum AgentRequestKind: String, Codable, Sendable {
    case permission
    case question
}

struct AgentInteractionRequest: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let kind: AgentRequestKind
    let prompt: String
    let toolName: String?
    let questions: [AgentQuestion]?
    let createdAt: Double
}

struct CompanionSession: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let tmuxSessionId: String
    let tmuxSessionName: String
    let agentSessionId: String?
    let agentSessionName: String
    let provider: AgentProvider
    let status: AgentStatusKind
    let summary: String
    let intent: String?
    let activity: AgentActivity?
    let requests: [AgentInteractionRequest]
    let windowName: String?
    let paneId: String?
    let paneIndex: Int?
    let updatedAt: Double
}

struct UsageWindow: Codable, Equatable, Identifiable, Sendable {
    let label: String
    let usedPercent: Double
    let remainingPercent: Double
    let resetsAt: Double?

    var id: String { label }
}

enum UsageState: String, Codable, Sendable {
    case available
    case unavailable
    case error
}

struct ProviderUsage: Codable, Equatable, Identifiable, Sendable {
    let provider: AgentProvider
    let state: UsageState
    let plan: String?
    let windows: [UsageWindow]
    let updatedAt: Double
    let message: String?

    var id: AgentProvider { provider }
}

struct CompanionSnapshot: Codable, Equatable, Sendable {
    let revision: Int
    let capturedAt: Double
    let sessions: [CompanionSession]
    let usage: [ProviderUsage]

    static let empty = CompanionSnapshot(
        revision: 0,
        capturedAt: 0,
        sessions: [],
        usage: []
    )

    var primarySession: CompanionSession? {
        sessions.first(where: { !$0.requests.isEmpty })
            ?? sessions.first(where: { $0.status == .needsInput })
            ?? sessions.first(where: { $0.status == .working })
            ?? sessions.first
    }
}

struct CompanionEnvelope: Decodable, Sendable {
    let type: String
    let snapshot: CompanionSnapshot?
    let code: String?
    let message: String?
}

struct AgentInteractionAnswer: Encodable, Sendable {
    let action: String
    let answers: [[String]]?
}

struct CompanionCommand: Encodable, Sendable {
    let type: String
    let paneId: String?
    let requestId: String
    let answer: AgentInteractionAnswer?
    let requestIdempotencyKey: String?

    static func answer(
        paneId: String,
        requestId: String,
        action: String,
        answers: [[String]]? = nil
    ) -> CompanionCommand {
        CompanionCommand(
            type: "answer_agent_request",
            paneId: paneId,
            requestId: requestId,
            answer: AgentInteractionAnswer(action: action, answers: answers),
            requestIdempotencyKey: UUID().uuidString
        )
    }

    static func refreshUsage() -> CompanionCommand {
        CompanionCommand(
            type: "refresh_usage",
            paneId: nil,
            requestId: UUID().uuidString,
            answer: nil,
            requestIdempotencyKey: nil
        )
    }
}
