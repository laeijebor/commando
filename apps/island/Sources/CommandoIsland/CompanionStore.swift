import AppKit
import Combine
import Foundation
import SwiftUI

enum CompanionConnection: Equatable {
    case connecting
    case connected
    case offline(String)

    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Live"
        case .offline: "Offline"
        }
    }
}

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var snapshot = CompanionSnapshot.empty
    @Published private(set) var connection: CompanionConnection = .connecting
    @Published private(set) var lastError: String?
    @Published var isExpanded = false
    @Published var selectedSessionID: String?

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var intentionalStop = false
    private var reconnectAttempt = 0

    var selectedSession: CompanionSession? {
        if let selectedSessionID,
           let selected = snapshot.sessions.first(where: { $0.id == selectedSessionID }) {
            return selected
        }
        return snapshot.primarySession
    }

    var pendingSession: CompanionSession? {
        snapshot.sessions.first(where: { !$0.requests.isEmpty })
    }

    var daemonPort: Int {
        let configured = UserDefaults.standard.integer(forKey: "CommandoPort")
        return configured == 0 ? 4310 : configured
    }

    func start() {
        intentionalStop = false
        connect()
    }

    func stop() {
        intentionalStop = true
        reconnectTask?.cancel()
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    func toggleExpanded() {
        withAnimation(.snappy(duration: 0.28)) {
            isExpanded.toggle()
        }
    }

    func collapseAfterHover() {
        guard pendingSession == nil else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, self.pendingSession == nil else { return }
            withAnimation(.snappy(duration: 0.25)) {
                self.isExpanded = false
            }
        }
    }

    func select(_ session: CompanionSession) {
        selectedSessionID = session.id
    }

    func answerPermission(
        session: CompanionSession,
        request: AgentInteractionRequest,
        action: String
    ) {
        guard let paneId = session.paneId else { return }
        send(.answer(paneId: paneId, requestId: request.id, action: action))
    }

    func answerQuestion(
        session: CompanionSession,
        request: AgentInteractionRequest,
        answers: [[String]]
    ) {
        guard let paneId = session.paneId else { return }
        send(.answer(
            paneId: paneId,
            requestId: request.id,
            action: "answer",
            answers: answers
        ))
    }

    func rejectQuestion(session: CompanionSession, request: AgentInteractionRequest) {
        guard let paneId = session.paneId else { return }
        send(.answer(paneId: paneId, requestId: request.id, action: "reject"))
    }

    func refreshUsage() {
        send(.refreshUsage())
    }

    func openCommando() {
        guard let url = URL(string: "http://127.0.0.1:\(daemonPort)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func connect() {
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        guard let token = companionToken() else {
            connection = .offline("Run npm run hooks:install once")
            scheduleReconnect()
            return
        }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = "127.0.0.1"
        components.port = daemonPort
        components.path = "/companion/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else {
            connection = .offline("Invalid daemon address")
            return
        }

        connection = .connecting
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        receiveTask = Task { [weak self, socket] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    self.connection = .connected
                    self.reconnectAttempt = 0
                    self.handle(message)
                }
            } catch {
                guard !self.intentionalStop, self.socket === socket else { return }
                self.socket = nil
                self.connection = .offline("Commando daemon unavailable")
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard !intentionalStop, reconnectTask == nil else { return }
        reconnectAttempt += 1
        let delay = min(pow(1.8, Double(reconnectAttempt - 1)), 15)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil
            self.connect()
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case let .data(value): data = value
        case let .string(value): data = Data(value.utf8)
        @unknown default: return
        }
        do {
            let envelope = try JSONDecoder().decode(CompanionEnvelope.self, from: data)
            if envelope.type == "companion_snapshot", let next = envelope.snapshot {
                snapshot = next
                if let pending = next.sessions.first(where: { !$0.requests.isEmpty }) {
                    selectedSessionID = pending.id
                    withAnimation(.snappy(duration: 0.3)) {
                        isExpanded = true
                    }
                } else if let selectedSessionID,
                          !next.sessions.contains(where: { $0.id == selectedSessionID }) {
                    self.selectedSessionID = next.primarySession?.id
                }
                lastError = nil
            } else if envelope.type == "companion_error" {
                lastError = envelope.message ?? envelope.code ?? "Companion request failed"
            }
        } catch {
            lastError = "Ignored an invalid daemon update"
        }
    }

    private func send(_ command: CompanionCommand) {
        guard let socket else {
            lastError = "Commando daemon is offline"
            return
        }
        do {
            let data = try JSONEncoder().encode(command)
            guard let text = String(data: data, encoding: .utf8) else { return }
            Task { [weak self, socket] in
                do {
                    try await socket.send(.string(text))
                } catch {
                    self?.lastError = "Could not reach Commando"
                }
            }
        } catch {
            lastError = "Could not encode companion request"
        }
    }

    private func companionToken() -> String? {
        let environment = ProcessInfo.processInfo.environment
        let path = environment["COMMANDO_AGENT_HOOK_TOKEN_PATH"]
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".commando/agent-hook-token").path
        guard let value = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.count >= 32 ? token : nil
    }
}
