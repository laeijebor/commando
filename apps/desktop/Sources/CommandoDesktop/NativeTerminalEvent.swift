import Foundation

enum NativeTerminalEventBuilder {
    static func envelope(
        pageId: String,
        eventSequence: Int,
        type: String,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "version": NativeTerminalProtocol.version,
            "pageId": pageId,
            "eventSequence": eventSequence,
            "type": type,
            "payload": payload,
        ]
    }

    static func bridgeConnected(capabilities: [String], maxPanes: Int) -> [String: Any] {
        ["capabilities": capabilities, "maxPanes": maxPanes]
    }

    static func bridgeRejected(reason: String) -> [String: Any] {
        ["reason": reason]
    }

    static func paneIdentity(_ identity: PaneIdentity) -> [String: Any] {
        ["paneId": identity.paneId, "attachmentId": identity.attachmentId]
    }

    static func paneSeeded(_ identity: PaneIdentity, revision: Int) -> [String: Any] {
        var payload = paneIdentity(identity)
        payload["revision"] = revision
        return payload
    }

    static func paneInput(_ identity: PaneIdentity, data: Data) -> [String: Any] {
        var payload = paneIdentity(identity)
        payload["data"] = data.base64EncodedString()
        return payload
    }

    static func paneResize(_ identity: PaneIdentity, size: GridSize) -> [String: Any] {
        var payload = paneIdentity(identity)
        payload["cols"] = size.cols
        payload["rows"] = size.rows
        return payload
    }

    static func paneFocusChanged(_ identity: PaneIdentity, focused: Bool) -> [String: Any] {
        var payload = paneIdentity(identity)
        payload["focused"] = focused
        return payload
    }

    static func paneFailed(
        _ identity: PaneIdentity?,
        code: String,
        fatal: Bool
    ) -> [String: Any] {
        var payload = identity.map(paneIdentity) ?? [:]
        payload["code"] = code
        payload["fatal"] = fatal
        return payload
    }

    static func hostShortcut(key: String) -> [String: Any] {
        ["key": key, "metaKey": true]
    }
}
