import SwiftUI

private let islandPurple = Color(red: 0.61, green: 0.42, blue: 1)
private let islandSurface = Color(red: 0.075, green: 0.068, blue: 0.095)
private let islandRaised = Color(red: 0.12, green: 0.105, blue: 0.15)

struct IslandRootView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var layout: IslandLayoutModel
    let onExpansionChange: (Bool) -> Void

    var body: some View {
        Group {
            if store.isExpanded {
                expandedView
            } else {
                CompactIsland(store: store, display: layout.display)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.black)
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: store.isExpanded ? 30 : 20,
            bottomTrailingRadius: store.isExpanded ? 30 : 20,
            topTrailingRadius: 0,
            style: .continuous
        ))
        .overlay(alignment: .bottom) {
            UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: store.isExpanded ? 30 : 20,
                bottomTrailingRadius: store.isExpanded ? 30 : 20,
                topTrailingRadius: 0,
                style: .continuous
            )
            .stroke(Color.white.opacity(store.isExpanded ? 0.09 : 0.04), lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if !store.isExpanded { store.toggleExpanded() }
        }
        .onHover { inside in
            store.hoverChanged(inside: inside)
        }
        .onChange(of: store.isExpanded) { _, expanded in
            onExpansionChange(expanded)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Commando Island")
    }

    private var expandedView: some View {
        VStack(spacing: 0) {
            IslandHeader(store: store)
                .padding(.horizontal, 22)
                .padding(.top, 14)
                .padding(.bottom, 12)

            Divider().overlay(Color.white.opacity(0.08))

            ScrollView {
                VStack(spacing: 14) {
                    if let selected = store.selectedSession {
                        SessionFocus(store: store, session: selected)
                    } else {
                        EmptyFocus(connection: store.connection)
                    }

                    SessionList(store: store)
                }
                .padding(18)
            }
            .scrollIndicators(.hidden)

            IslandFooter(store: store)
                .padding(.horizontal, 18)
                .padding(.bottom, 13)
        }
        .foregroundStyle(.white)
    }
}

private struct CompactIsland: View {
    @ObservedObject var store: CompanionStore
    let display: IslandDisplayLayout

    var body: some View {
        Group {
            if display.cameraGapWidth > 0 {
                HStack(spacing: 0) {
                    leftContent
                        .padding(.leading, IslandGeometry.compactHorizontalPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .clipped()
                    Color.clear
                        .frame(width: display.cameraGapWidth)
                    rightContent
                        .padding(.trailing, IslandGeometry.compactHorizontalPadding)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .clipped()
                }
            } else {
                HStack(spacing: 12) {
                    leftContent
                    Spacer(minLength: 8)
                    rightContent
                }
                .padding(.horizontal, IslandGeometry.compactHorizontalPadding)
            }
        }
        .frame(height: display.compactSize.height)
    }

    @ViewBuilder
    private var leftContent: some View {
        if let session = store.snapshot.primarySession {
            HStack(spacing: 12) {
                StatusGlyph(status: session.status, provider: session.provider)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.tmuxSessionName)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(session.agentSessionName)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                }
            }
        } else {
            HStack(spacing: 12) {
                Circle()
                    .fill(connectionColor(store.connection))
                    .frame(width: 7, height: 7)
                Text(store.connection.label)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
    }

    @ViewBuilder
    private var rightContent: some View {
        if let session = store.snapshot.primarySession {
            HStack(spacing: 10) {
                Text(session.status.displayName)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(statusColor(session.status))
                CompactUsage(usage: store.snapshot.usage)
                Text("\(store.snapshot.sessions.count) sessions")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        } else {
            Text("Commando")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.45))
        }
    }
}

private struct CompactUsage: View {
    let usage: [ProviderUsage]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(usage) { provider in
                if let window = provider.windows.min(by: { $0.remainingPercent < $1.remainingPercent }) {
                    Text("\(provider.provider == .claude ? "CL" : "CX") \(window.label) \(Int(window.remainingPercent.rounded()))%")
                        .foregroundStyle(usageColor(window.remainingPercent))
                } else {
                    Text("\(provider.provider == .claude ? "CL" : "CX") --")
                        .foregroundStyle(.white.opacity(0.3))
                }
            }
        }
        .font(.system(size: 9, weight: .bold, design: .monospaced))
    }
}

private struct IslandHeader: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 7) {
                Circle()
                    .fill(connectionColor(store.connection))
                    .frame(width: 7, height: 7)
                    .shadow(color: connectionColor(store.connection).opacity(0.7), radius: 4)
                Text("COMMANDO")
                    .font(.system(size: 11, weight: .black, design: .rounded))
                    .tracking(1.4)
                Text(store.connection.label.uppercased())
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.42))
            }

            Spacer()
            UsageStrip(usage: store.snapshot.usage)
            Button {
                store.toggleExpanded()
            } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 26, height: 26)
                    .background(Color.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Collapse Commando Island")
        }
    }
}

private struct UsageStrip: View {
    let usage: [ProviderUsage]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            HStack(spacing: 8) {
                ForEach(usage) { provider in
                    HStack(spacing: 5) {
                        Text(provider.provider == .claude ? "CL" : "CX")
                            .foregroundStyle(provider.provider == .claude ? .orange : .cyan)
                        if provider.windows.isEmpty {
                            Text("--")
                                .foregroundStyle(.white.opacity(0.3))
                        } else {
                            ForEach(provider.windows) { window in
                                HStack(spacing: 3) {
                                    Text(window.label)
                                        .foregroundStyle(.white.opacity(0.45))
                                    Text("\(Int(window.remainingPercent.rounded()))%")
                                        .foregroundStyle(usageColor(window.remainingPercent))
                                    if let resetsAt = window.resetsAt {
                                        Text(countdown(until: resetsAt))
                                            .foregroundStyle(.white.opacity(0.35))
                                    }
                                }
                            }
                        }
                    }
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                }
            }
        }
    }
}

private struct SessionFocus: View {
    @ObservedObject var store: CompanionStore
    let session: CompanionSession

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 12) {
                StatusGlyph(status: session.status, provider: session.provider, large: true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.tmuxSessionName)
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                    Text(session.agentSessionName)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(islandPurple.opacity(0.9))
                    if let location = sessionLocation(session) {
                        Text(location)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.38))
                    }
                }
                Spacer()
                Text(session.status.displayName.uppercased())
                    .font(.system(size: 9, weight: .black, design: .rounded))
                    .foregroundStyle(statusColor(session.status))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(statusColor(session.status).opacity(0.13), in: Capsule())
            }

            if let request = session.requests.first {
                RequestView(store: store, session: session, request: request)
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    if let intent = session.intent {
                        Label(intent, systemImage: "scope")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                    }
                    if let activity = session.activity {
                        Label(activity.label, systemImage: "waveform.path.ecg")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.7))
                    } else {
                        Text(session.summary)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.72))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(13)
                .background(islandRaised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .padding(16)
        .background(islandSurface, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 21, style: .continuous)
                .stroke(session.requests.isEmpty ? Color.white.opacity(0.06) : islandPurple.opacity(0.45))
        }
    }
}

private struct RequestView: View {
    @ObservedObject var store: CompanionStore
    let session: CompanionSession
    let request: AgentInteractionRequest

    var body: some View {
        if request.kind == .permission {
            PermissionRequestView(store: store, session: session, request: request)
        } else {
            QuestionRequestView(store: store, session: session, request: request)
        }
    }
}

private struct PermissionRequestView: View {
    @ObservedObject var store: CompanionStore
    let session: CompanionSession
    let request: AgentInteractionRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(.orange)
                Text("PERMISSION REQUEST")
                    .font(.system(size: 10, weight: .black, design: .rounded))
                    .tracking(0.8)
                if let toolName = request.toolName {
                    Text(toolName)
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                }
            }
            Text(request.prompt)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .textSelection(.enabled)

            HStack(spacing: 8) {
                RequestButton(title: "Deny", role: .deny) {
                    store.answerPermission(session: session, request: request, action: "deny")
                }
                RequestButton(title: "Allow once", role: .allow) {
                    store.answerPermission(session: session, request: request, action: "allow_once")
                }
                RequestButton(title: "Always allow", role: .always) {
                    store.answerPermission(session: session, request: request, action: "allow_always")
                }
            }
        }
        .padding(14)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }
}

private struct QuestionRequestView: View {
    @ObservedObject var store: CompanionStore
    let session: CompanionSession
    let request: AgentInteractionRequest
    @State private var selections: [Set<String>]
    @State private var customAnswers: [String]

    init(store: CompanionStore, session: CompanionSession, request: AgentInteractionRequest) {
        self.store = store
        self.session = session
        self.request = request
        let count = request.questions?.count ?? 0
        _selections = State(initialValue: Array(repeating: Set<String>(), count: count))
        _customAnswers = State(initialValue: Array(repeating: "", count: count))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("AGENT ASKS", systemImage: "questionmark.bubble.fill")
                .font(.system(size: 10, weight: .black, design: .rounded))
                .tracking(0.8)
                .foregroundStyle(islandPurple)

            ForEach(Array((request.questions ?? []).enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.42))
                    Text(question.question)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                    if !question.options.isEmpty {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 7)], spacing: 7) {
                            ForEach(question.options) { option in
                                Button {
                                    choose(option.label, for: question, at: index)
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: selections[index].contains(option.label)
                                            ? "checkmark.circle.fill" : "circle")
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(option.label).fontWeight(.semibold)
                                            if let description = option.description {
                                                Text(description)
                                                    .font(.system(size: 9))
                                                    .foregroundStyle(.white.opacity(0.45))
                                                    .lineLimit(1)
                                            }
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(
                                        selections[index].contains(option.label)
                                            ? islandPurple.opacity(0.2) : Color.white.opacity(0.06),
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if question.custom {
                        TextField("Type another answer", text: $customAnswers[index])
                            .textFieldStyle(.plain)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .padding(.horizontal, 11)
                            .padding(.vertical, 9)
                            .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }

            HStack(spacing: 8) {
                RequestButton(title: "Dismiss", role: .deny) {
                    store.rejectQuestion(session: session, request: request)
                }
                RequestButton(title: "Send answer", role: .always, disabled: !canSubmit) {
                    store.answerQuestion(session: session, request: request, answers: answers)
                }
            }
        }
        .padding(14)
        .background(islandPurple.opacity(0.08), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var answers: [[String]] {
        selections.indices.map { index in
            var values = selections[index].sorted()
            let custom = customAnswers[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if !custom.isEmpty { values.append(custom) }
            return values
        }
    }

    private var canSubmit: Bool {
        !answers.isEmpty && answers.allSatisfy { !$0.isEmpty }
    }

    private func choose(_ label: String, for question: AgentQuestion, at index: Int) {
        if question.multiple {
            if selections[index].contains(label) { selections[index].remove(label) }
            else { selections[index].insert(label) }
        } else {
            selections[index] = [label]
        }
    }
}

private struct RequestButton: View {
    enum Role { case deny, allow, always }

    let title: String
    let role: Role
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .foregroundStyle(foreground)
                .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    private var foreground: Color { role == .allow ? .black : .white }
    private var background: Color {
        switch role {
        case .deny: Color.white.opacity(0.08)
        case .allow: .white
        case .always: islandPurple
        }
    }
}

private struct SessionList: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ALL SESSIONS")
                    .font(.system(size: 9, weight: .black, design: .rounded))
                    .tracking(1)
                    .foregroundStyle(.white.opacity(0.4))
                Spacer()
                Text("\(store.snapshot.sessions.count)")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }

            ForEach(store.snapshot.sessions) { session in
                Button {
                    store.select(session)
                } label: {
                    HStack(spacing: 10) {
                        StatusGlyph(status: session.status, provider: session.provider)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.tmuxSessionName)
                                .font(.system(size: 11, weight: .bold, design: .rounded))
                            Text(session.agentSessionName)
                                .font(.system(size: 9, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.45))
                                .lineLimit(1)
                        }
                        Spacer()
                        Text(session.status.displayName)
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(statusColor(session.status))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white.opacity(0.22))
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .background(
                        store.selectedSession?.id == session.id
                            ? islandPurple.opacity(0.14) : Color.white.opacity(0.035),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct IslandFooter: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        HStack {
            if let error = store.lastError {
                Text(error)
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.orange)
                    .lineLimit(1)
            } else {
                Text("Local only / credentials never leave this Mac")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.28))
            }
            Spacer()
            Button("Refresh usage") { store.refreshUsage() }
                .buttonStyle(.plain)
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(.white.opacity(0.45))
            Button("Open Commando") { store.openCommando() }
                .buttonStyle(.plain)
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(islandPurple)
        }
    }
}

private struct EmptyFocus: View {
    let connection: CompanionConnection

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: "terminal")
                .font(.system(size: 25, weight: .light))
                .foregroundStyle(islandPurple)
            Text(connection == .connected ? "No tmux sessions found" : "Waiting for Commando")
                .font(.system(size: 13, weight: .bold, design: .rounded))
            if case let .offline(detail) = connection {
                Text(detail)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 35)
        .background(islandSurface, in: RoundedRectangle(cornerRadius: 20))
    }
}

private struct StatusGlyph: View {
    let status: AgentStatusKind
    let provider: AgentProvider
    var large = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: large ? 11 : 7, style: .continuous)
                .fill(statusColor(status).opacity(0.14))
            Image(systemName: providerSymbol(provider))
                .font(.system(size: large ? 16 : 10, weight: .bold))
                .foregroundStyle(statusColor(status))
        }
        .frame(width: large ? 39 : 25, height: large ? 39 : 25)
        .overlay(alignment: .bottomTrailing) {
            Circle()
                .fill(statusColor(status))
                .frame(width: large ? 8 : 6, height: large ? 8 : 6)
                .overlay(Circle().stroke(Color.black, lineWidth: 2))
        }
    }
}

private func providerSymbol(_ provider: AgentProvider) -> String {
    switch provider {
    case .claude: "sparkles"
    case .codex: "chevron.left.forwardslash.chevron.right"
    case .opencode: "terminal.fill"
    case .unknown: "circle.dotted"
    }
}

private func statusColor(_ status: AgentStatusKind) -> Color {
    switch status {
    case .needsInput: .orange
    case .failed: .red
    case .working: islandPurple
    case .done: .green
    case .stale, .unknown: Color.white.opacity(0.4)
    }
}

private func connectionColor(_ connection: CompanionConnection) -> Color {
    switch connection {
    case .connected: .green
    case .connecting: islandPurple
    case .offline: .red
    }
}

private func usageColor(_ remaining: Double) -> Color {
    if remaining > 50 { return .green }
    if remaining > 20 { return .orange }
    return .red
}

private func countdown(until milliseconds: Double) -> String {
    let seconds = max(0, milliseconds / 1_000 - Date().timeIntervalSince1970)
    if seconds >= 86_400 { return "\(Int(seconds / 86_400))d" }
    if seconds >= 3_600 { return "\(Int(seconds / 3_600))h" }
    return "\(max(1, Int(seconds / 60)))m"
}

private func sessionLocation(_ session: CompanionSession) -> String? {
    guard let windowName = session.windowName else { return nil }
    if let paneIndex = session.paneIndex { return "\(windowName) / pane \(paneIndex)" }
    return windowName
}
