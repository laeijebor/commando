import Foundation
import WebKit

enum DesktopWindowRole: Equatable, Sendable {
    case workspace
    case webPane(id: String)

    var webPaneId: String? {
        guard case let .webPane(id) = self else { return nil }
        return id
    }

    func applicationURL(baseURL: URL) -> URL {
        guard case let .webPane(id) = self,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            return baseURL
        }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "commandoWindow" || $0.name == "webPaneId" }
        items.append(URLQueryItem(name: "commandoWindow", value: "web-pane"))
        items.append(URLQueryItem(name: "webPaneId", value: id))
        components.queryItems = items
        return components.url ?? baseURL
    }
}

enum NativeWindowProtocol {
    static let protocolName = "commando.native-window"
    static let handlerName = "commandoNativeWindow"
    static let version = 1

    static func isWebPaneId(_ value: String) -> Bool {
        guard value.count == 10, value.hasPrefix("w-") else { return false }
        return value.dropFirst(2).allSatisfy { $0.isHexDigit }
    }
}

@MainActor
protocol DesktopWindowCommandHandling: AnyObject {
    func openWebPaneWindow(webPaneId: String)
    func focusWebPaneWindow(webPaneId: String)
    func reattachWebPaneWindow(webPaneId: String)
}

@MainActor
final class NativeWindowBridge {
    weak var commandHandler: (any DesktopWindowCommandHandling)?

    init(commandHandler: (any DesktopWindowCommandHandling)? = nil) {
        self.commandHandler = commandHandler
    }

    func receive(body: Any) {
        guard let dictionary = body as? [String: Any],
              dictionary["protocol"] as? String == NativeWindowProtocol.protocolName,
              (dictionary["version"] as? NSNumber)?.intValue == NativeWindowProtocol.version,
              let type = dictionary["type"] as? String,
              let payload = dictionary["payload"] as? [String: Any],
              let webPaneId = payload["webPaneId"] as? String,
              NativeWindowProtocol.isWebPaneId(webPaneId)
        else {
            return
        }

        switch type {
        case "web-pane.open":
            commandHandler?.openWebPaneWindow(webPaneId: webPaneId)
        case "web-pane.focus":
            commandHandler?.focusWebPaneWindow(webPaneId: webPaneId)
        case "web-pane.reattach":
            commandHandler?.reattachWebPaneWindow(webPaneId: webPaneId)
        default:
            return
        }
    }
}

@MainActor
final class NativeWindowScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var bridge: NativeWindowBridge?
    private let admission: WebContentAdmission

    init(bridge: NativeWindowBridge, admission: WebContentAdmission) {
        self.bridge = bridge
        self.admission = admission
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let origin = message.frameInfo.securityOrigin
        guard admission.allowsBridgeMessage(
            isMainFrame: message.frameInfo.isMainFrame,
            scheme: origin.protocol,
            host: origin.host,
            port: origin.port
        ) else {
            return
        }
        bridge?.receive(body: message.body)
    }
}
