import AppKit
import Foundation

enum ExternalURLDisposition: Equatable, Sendable {
    case allowInWebView
    case openExternally
    case cancel
}

enum ExternalURLSource: Equatable, Sendable {
    case webNavigation(opensInNewWindow: Bool)
    case trustedWebLink(opensInNewWindow: Bool)
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

        if privilegedOrigin?.matches(url: url) == true {
            switch source {
            case let .webNavigation(opensInNewWindow):
                return opensInNewWindow ? .cancel : .allowInWebView
            case let .trustedWebLink(opensInNewWindow):
                return opensInNewWindow ? .openExternally : .allowInWebView
            case .terminalHyperlink:
                return .openExternally
            }
        }

        switch source {
        case .webNavigation:
            return .cancel
        case .trustedWebLink, .terminalHyperlink:
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
protocol ExternalURLOpenFailureReporting {
    func reportFailure(opening url: URL)
}

@MainActor
struct AppKitExternalURLOpenFailureReporter: ExternalURLOpenFailureReporting {
    func reportFailure(opening url: URL) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Unable to Open Link"
        alert.informativeText = "Commando could not open \(url.absoluteString) in the system browser."
        alert.addButton(withTitle: "OK")
        if let window = NSApp.keyWindow {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
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
    private let failureReporter: any ExternalURLOpenFailureReporting

    init(
        privilegedOrigin: WebOrigin? = nil,
        opener: any SystemURLOpening = WorkspaceSystemURLOpener(),
        failureReporter: any ExternalURLOpenFailureReporting = AppKitExternalURLOpenFailureReporter()
    ) {
        policy = SecureExternalURLPolicy(privilegedOrigin: privilegedOrigin)
        self.opener = opener
        self.failureReporter = failureReporter
    }

    @discardableResult
    func handle(_ url: URL?, source: ExternalURLSource) -> ExternalURLDisposition {
        let disposition = policy.disposition(for: url, source: source)
        if disposition == .openExternally, let url {
            if !opener.open(url) {
                failureReporter.reportFailure(opening: url)
            }
        }
        return disposition
    }
}
