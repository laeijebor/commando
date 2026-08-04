import AppKit
import Foundation

enum ExternalURLDisposition: Equatable, Sendable {
    case allowInWebView
    case openExternally
    case cancel
}

enum ExternalURLSource: Equatable, Sendable {
    case webNavigation(userActivated: Bool, opensInNewWindow: Bool)
    case terminalHyperlink
}

struct SecureExternalURLPolicy: Equatable, Sendable {
    let privilegedOrigin: WebOrigin?

    func disposition(for url: URL?, source: ExternalURLSource) -> ExternalURLDisposition {
        guard let url,
              url.user == nil,
              url.password == nil,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else {
            return .cancel
        }

        if case .webNavigation = source,
           privilegedOrigin?.matches(url: url) == true {
            return .allowInWebView
        }

        switch source {
        case let .webNavigation(userActivated, _):
            return userActivated ? .openExternally : .cancel
        case .terminalHyperlink:
            return .openExternally
        }
    }
}

@MainActor
protocol SystemURLOpening {
    @discardableResult
    func open(_ url: URL) -> Bool
}

@MainActor
struct WorkspaceSystemURLOpener: SystemURLOpening {
    @discardableResult
    func open(_ url: URL) -> Bool {
        NSWorkspace.shared.open(url)
    }
}

@MainActor
protocol ExternalURLHandling: AnyObject {
    @discardableResult
    func handle(_ url: URL?, source: ExternalURLSource) -> ExternalURLDisposition
}

@MainActor
final class SafeExternalURLHandler: ExternalURLHandling {
    private let policy: SecureExternalURLPolicy
    private let opener: any SystemURLOpening

    init(
        privilegedOrigin: WebOrigin? = nil,
        opener: any SystemURLOpening = WorkspaceSystemURLOpener()
    ) {
        policy = SecureExternalURLPolicy(privilegedOrigin: privilegedOrigin)
        self.opener = opener
    }

    @discardableResult
    func handle(_ url: URL?, source: ExternalURLSource) -> ExternalURLDisposition {
        let disposition = policy.disposition(for: url, source: source)
        if disposition == .openExternally, let url {
            _ = opener.open(url)
        }
        return disposition
    }
}
