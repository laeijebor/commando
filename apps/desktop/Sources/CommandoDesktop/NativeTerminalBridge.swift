import Foundation
import Metal
import WebKit

@MainActor
protocol NativeTerminalMessageReceiving: AnyObject {
    func receiveNativeTerminalMessage(body: Any)
}

@MainActor
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var receiver: (any NativeTerminalMessageReceiving)?
    private let admission: WebContentAdmission

    init(receiver: any NativeTerminalMessageReceiving, admission: WebContentAdmission) {
        self.receiver = receiver
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
        receiver?.receiveNativeTerminalMessage(body: message.body)
    }
}

@MainActor
final class NativeTerminalBridge: NativeTerminalMessageReceiving {
    private weak var webView: WKWebView?
    private let overlay: TerminalOverlayView
    private let prefersMetal: Bool
    private let pasteboard: NSPasteboard
    private let externalURLHandler: any ExternalURLHandling
    private let eventObserver: (([String: Any]) -> Void)?
    private var sequenceGate = BridgeSequenceGate()
    private var eventSequence = 0
    private var suppressSurfaceEvents = false
    private lazy var paneHost = TerminalPaneHost(
        overlay: overlay,
        fallbackResponder: webView,
        prefersMetal: prefersMetal,
        pasteboard: pasteboard,
        externalURLHandler: externalURLHandler
    ) { [weak self] identity, event in
        self?.receiveSurfaceEvent(identity: identity, event: event)
    }

    init(
        webView: WKWebView?,
        overlay: TerminalOverlayView,
        prefersMetal: Bool,
        pasteboard: NSPasteboard = .general,
        externalURLHandler: (any ExternalURLHandling)? = nil,
        eventObserver: (([String: Any]) -> Void)? = nil
    ) {
        self.webView = webView
        self.overlay = overlay
        self.prefersMetal = prefersMetal
        self.pasteboard = pasteboard
        self.externalURLHandler = externalURLHandler ?? SafeExternalURLHandler()
        self.eventObserver = eventObserver
    }

    var surfaceCount: Int { paneHost.surfaceCount }

    func receiveNativeTerminalMessage(body: Any) {
        let envelope: NativeTerminalEnvelope
        do {
            envelope = try NativeTerminalEnvelope.decode(jsonObject: body)
        } catch let error as ProtocolValidationError {
            sendRejection(
                code: error.code,
                message: error.message,
                pageId: NativeTerminalEnvelope.recoverablePageId(from: body),
                identity: NativeTerminalEnvelope.recoverableIdentity(from: body)
            )
            return
        } catch {
            sendRejection(code: "invalid_payload", message: "Malformed native terminal message.")
            return
        }

        if case let .connect(payload) = envelope.command,
           !payload.supportedVersions.contains(NativeTerminalProtocol.version) {
            sendRejection(
                code: "no_supported_version",
                message: "The page does not support native terminal bridge version 1.",
                pageId: envelope.pageId
            )
            return
        }

        switch sequenceGate.accept(envelope) {
        case .connected:
            withoutSurfaceEvents {
                paneHost.destroyAll()
            }
            eventSequence = 0
            emit(
                type: "bridge.connected",
                payload: NativeTerminalEventBuilder.bridgeConnected(
                    capabilities: rendererCapabilities,
                    maxPanes: NativeTerminalProtocol.maxPanes
                ),
                pageId: envelope.pageId
            )
        case .accepted:
            handle(envelope.command)
        case let .rejected(code):
            sendRejection(
                code: code,
                message: "Native terminal message was stale or out of sequence.",
                pageId: envelope.pageId,
                identity: identity(for: envelope.command)
            )
        }
    }

    func pageWasReplaced() {
        withoutSurfaceEvents {
            paneHost.destroyAll()
        }
        sequenceGate.reset()
        eventSequence = 0
    }

    func reapplyFrames() {
        paneHost.reapplyFrames()
    }

    func setZoomScale(_ scale: CGFloat) {
        paneHost.setZoomScale(scale)
    }

    func cleanUp() {
        pageWasReplaced()
    }

    private var rendererCapabilities: [String] {
        var capabilities = NativeTerminalProtocol.requiredCapabilities
        if MTLCreateSystemDefaultDevice() != nil {
            capabilities.append("terminal.metal")
        }
        return capabilities
    }

    private func handle(_ command: NativeTerminalCommand) {
        switch command {
        case .connect:
            break
        case let .attach(payload):
            let result = paneHost.attach(payload)
            guard result != .capacityExceeded else {
                emitPaneFailure(
                    identity: payload.identity,
                    code: "max_panes",
                    message: "The native terminal surface limit has been reached."
                )
                return
            }
            emit(
                type: "pane.attached",
                payload: NativeTerminalEventBuilder.paneIdentity(payload.identity)
            )
        case let .update(payload):
            _ = paneHost.update(payload)
        case let .frame(payload):
            _ = paneHost.applyFrame(payload)
        case let .focus(identity):
            _ = paneHost.focus(identity)
        case let .reset(payload):
            if paneHost.applyReset(payload) {
                emit(
                    type: "pane.seeded",
                    payload: NativeTerminalEventBuilder.paneSeeded(
                        payload.identity,
                        revision: payload.revision
                    )
                )
            }
        case let .data(payload):
            _ = paneHost.applyData(payload)
        case let .detach(identity):
            if paneHost.detach(identity) {
                emit(
                    type: "pane.detached",
                    payload: NativeTerminalEventBuilder.paneIdentity(identity)
                )
            }
        }
    }

    func receiveSurfaceEvent(identity: PaneIdentity, event: TerminalSurfaceEvent) {
        guard !suppressSurfaceEvents else { return }
        switch event {
        case let .input(data):
            emit(
                type: "pane.input_bytes",
                payload: NativeTerminalEventBuilder.paneInput(identity, data: data)
            )
        case let .paste(text):
            emit(
                type: "pane.paste_text",
                payload: NativeTerminalEventBuilder.panePaste(identity, text: text)
            )
        case let .resize(size):
            emit(
                type: "pane.resize",
                payload: NativeTerminalEventBuilder.paneResize(identity, size: size)
            )
        case let .focusChanged(focused):
            emit(
                type: "pane.focus_changed",
                payload: NativeTerminalEventBuilder.paneFocusChanged(identity, focused: focused)
            )
        case .selectionCopied:
            emit(
                type: "pane.selection_copied",
                payload: NativeTerminalEventBuilder.paneIdentity(identity)
            )
        case let .contextMenu(point):
            // The context menu is DOM content: give the web view first responder
            // before the event lands so the menu is keyboard-operable and a later
            // focus change cannot blur the page and dismiss the menu as it opens.
            if let webView, webView.window?.firstResponder !== webView {
                webView.window?.makeFirstResponder(webView)
            }
            emit(
                type: "pane.context_menu",
                payload: NativeTerminalEventBuilder.paneContextMenu(identity, point: point)
            )
        case let .shortcut(key):
            sendHostShortcut(key)
        }
    }

    func sendHostShortcut(_ key: String) {
        emit(type: "host.shortcut", payload: NativeTerminalEventBuilder.hostShortcut(key: key))
    }

    private func emitPaneFailure(identity: PaneIdentity, code: String, message: String) {
        emit(
            type: "pane.failed",
            payload: NativeTerminalEventBuilder.paneFailed(identity, code: code, fatal: false)
        )
        NSLog("CommandoDesktop native terminal pane failed: %@", message)
    }

    private func sendRejection(
        code: String,
        message: String,
        pageId: String? = nil,
        identity: PaneIdentity? = nil
    ) {
        emit(
            type: "bridge.rejected",
            payload: NativeTerminalEventBuilder.bridgeRejected(reason: code, identity: identity),
            pageId: pageId ?? sequenceGate.pageId ?? ""
        )
        NSLog("CommandoDesktop rejected native terminal message: %@", message)
    }

    private func identity(for command: NativeTerminalCommand) -> PaneIdentity? {
        switch command {
        case .connect:
            nil
        case let .attach(payload):
            payload.identity
        case let .update(payload):
            payload.identity
        case let .frame(payload):
            payload.identity
        case let .focus(identity):
            identity
        case let .reset(payload):
            payload.identity
        case let .data(payload):
            payload.identity
        case let .detach(identity):
            identity
        }
    }

    private func emit(type: String, payload: [String: Any], pageId: String? = nil) {
        let resolvedPageId = pageId ?? sequenceGate.pageId ?? ""
        guard !resolvedPageId.isEmpty,
              eventSequence < NativeTerminalProtocol.maxSafeInteger
        else {
            return
        }
        eventSequence += 1
        let event = NativeTerminalEventBuilder.envelope(
            pageId: resolvedPageId,
            eventSequence: eventSequence,
            type: type,
            payload: payload
        )
        if let eventObserver {
            eventObserver(event)
            return
        }
        guard let webView else { return }
        webView.callAsyncJavaScript(
            """
            if (typeof window.__commandoNativeTerminalReceive === "function") {
                window.__commandoNativeTerminalReceive(event);
            }
            """,
            arguments: ["event": event],
            in: nil,
            in: .page
        ) { result in
            if case let .failure(error) = result {
                NSLog("CommandoDesktop failed to deliver native terminal event: %@", String(describing: error))
            }
        }
    }

    func withoutSurfaceEvents(_ operation: () -> Void) {
        suppressSurfaceEvents = true
        operation()
        suppressSurfaceEvents = false
    }
}
