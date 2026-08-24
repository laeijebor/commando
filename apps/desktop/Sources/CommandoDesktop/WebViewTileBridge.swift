import AppKit
import WebKit

/**
 The native web-view tier for Commando's web pane tiles.

 The web client renders localhost tiles as sandboxed iframes even inside the
 desktop shell — that already works. This bridge exists for external origins
 that refuse framing (X-Frame-Options / frame-ancestors): the page asks the
 host to place a real WKWebView over the tile's rectangle, driven by the same
 CSS-pixel frame + visible-region protocol the native terminals use, so DOM
 overlays keep masking the native view correctly.
 */
enum WebViewTileProtocol {
    static let protocolName = "commando.native-webview"
    static let handlerName = "commandoNativeWebView"
    static let version = 1
    static let maxTiles = 8
    static let capabilities = ["webview.embed.v1"]
    static let maxURLLength = 2_048
    /// Tile host views sort above the terminal surfaces in the shared overlay.
    static let hostOrderBase = 1_000
}

@MainActor
final class WebViewTileScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var bridge: WebViewTileBridge?
    private let admission: WebContentAdmission

    init(bridge: WebViewTileBridge, admission: WebContentAdmission) {
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

@MainActor
final class WebViewTileHostView: NSView {
    var hostOrderRank = 0
    var visibleRegions: [CGRect] = []

    override var isOpaque: Bool { false }
    override var tag: Int { WebViewTileProtocol.hostOrderBase + hostOrderRank }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, visibleRegions.contains(where: { $0.contains(point) }) else { return nil }
        return super.hitTest(point)
    }
}

enum WebViewTileEvent {
    case loaded
    case failed(code: String)
}

@MainActor
final class WebViewTile: NSObject, WKNavigationDelegate, WKUIDelegate {
    let identity: PaneIdentity
    let hostView = WebViewTileHostView(frame: .zero)
    let webView: WKWebView
    private(set) var latestFrame: PaneFramePayload?
    private let externalURLHandler: any ExternalURLHandling
    private let eventSink: (PaneIdentity, WebViewTileEvent) -> Void
    private let mask = CAShapeLayer()

    init(
        identity: PaneIdentity,
        url: URL,
        externalURLHandler: any ExternalURLHandling,
        eventSink: @escaping (PaneIdentity, WebViewTileEvent) -> Void
    ) {
        self.identity = identity
        self.externalURLHandler = externalURLHandler
        self.eventSink = eventSink
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        hostView.wantsLayer = true
        webView.wantsLayer = true
        hostView.addSubview(webView)
        webView.load(URLRequest(url: url))
    }

    func apply(placement: TerminalPlacement, frame payload: PaneFramePayload) {
        latestFrame = payload
        hostView.isHidden = placement.isHidden
        hostView.visibleRegions = placement.visibleFrames
        hostView.hostOrderRank = payload.order
        hostView.layer?.zPosition = CGFloat(WebViewTileProtocol.hostOrderBase + payload.order)
        guard !placement.isHidden else { return }
        webView.frame = placement.frame
        let path = CGMutablePath()
        for region in placement.visibleFrames {
            path.addRect(region.offsetBy(dx: -placement.frame.minX, dy: -placement.frame.minY))
        }
        mask.frame = webView.bounds
        mask.path = path
        webView.layer?.mask = mask
    }

    func reload() {
        if webView.reload() == nil, let url = webView.url {
            webView.load(URLRequest(url: url))
        }
    }

    func destroy() {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        hostView.removeFromSuperview()
    }

    func webView(
        _ webView: WKWebView,
        didFinish navigation: WKNavigation!
    ) {
        eventSink(identity, .loaded)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame == nil {
            externalURLHandler.handle(url, source: .webNavigation(opensInNewWindow: true))
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        externalURLHandler.handle(
            navigationAction.request.url,
            source: .webNavigation(opensInNewWindow: true)
        )
        return nil
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        if (error as NSError).code != NSURLErrorCancelled {
            eventSink(identity, .failed(code: "load_failed"))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        eventSink(identity, .failed(code: "content_process_terminated"))
    }
}

@MainActor
final class WebViewTileBridge: NSObject {
    private weak var hostWebView: WKWebView?
    private let overlay: TerminalOverlayView
    private let externalURLHandler: any ExternalURLHandling
    private let eventObserver: (([String: Any]) -> Void)?
    private var pageId: String?
    private var lastSequence = 0
    private var eventSequence = 0
    private var tiles: [String: WebViewTile] = [:]
    private(set) var zoomScale: CGFloat = 1

    init(
        webView: WKWebView?,
        overlay: TerminalOverlayView,
        externalURLHandler: (any ExternalURLHandling)? = nil,
        eventObserver: (([String: Any]) -> Void)? = nil
    ) {
        hostWebView = webView
        self.overlay = overlay
        self.externalURLHandler = externalURLHandler ?? SafeExternalURLHandler()
        self.eventObserver = eventObserver
    }

    var tileCount: Int { tiles.count }

    func receive(body: Any) {
        guard let dictionary = body as? [String: Any],
              dictionary["protocol"] as? String == WebViewTileProtocol.protocolName,
              (dictionary["version"] as? NSNumber)?.intValue == WebViewTileProtocol.version,
              let messagePageId = dictionary["pageId"] as? String,
              !messagePageId.isEmpty,
              let sequence = (dictionary["sequence"] as? NSNumber)?.intValue,
              sequence > 0,
              let type = dictionary["type"] as? String,
              let payload = dictionary["payload"] as? [String: Any]
        else {
            return
        }

        if type == "bridge.connect" {
            destroyAllTiles()
            pageId = messagePageId
            lastSequence = sequence
            eventSequence = 0
            emit(type: "bridge.connected", payload: [
                "capabilities": WebViewTileProtocol.capabilities,
                "maxWebViews": WebViewTileProtocol.maxTiles,
            ])
            return
        }
        guard messagePageId == pageId, sequence > lastSequence else { return }
        lastSequence = sequence

        switch type {
        case "webview.attach":
            attach(payload)
        case "webview.frame":
            applyFrame(payload)
        case "webview.reload":
            tile(for: payload)?.reload()
        case "webview.detach":
            detach(payload)
        default:
            emit(type: "bridge.rejected", payload: ["reason": "unknown_command"])
        }
    }

    func pageWasReplaced() {
        destroyAllTiles()
        pageId = nil
        lastSequence = 0
        eventSequence = 0
    }

    func cleanUp() {
        pageWasReplaced()
    }

    func reapplyFrames() {
        for tile in tiles.values {
            guard let frame = tile.latestFrame else { continue }
            tile.apply(placement: placement(for: frame), frame: frame)
        }
        sortOverlaySubviews()
    }

    func setZoomScale(_ scale: CGFloat) {
        guard scale.isFinite,
              (TerminalGeometry.minContentScale...TerminalGeometry.maxContentScale).contains(scale),
              scale != zoomScale
        else {
            return
        }
        zoomScale = scale
        reapplyFrames()
    }

    private func identity(from payload: [String: Any]) -> PaneIdentity? {
        guard let webPaneId = payload["webPaneId"] as? String,
              !webPaneId.isEmpty,
              webPaneId.count <= 64,
              let attachmentId = payload["attachmentId"] as? String,
              !attachmentId.isEmpty,
              attachmentId.count <= 128
        else {
            return nil
        }
        return PaneIdentity(paneId: webPaneId, attachmentId: attachmentId)
    }

    private func tile(for payload: [String: Any]) -> WebViewTile? {
        guard let identity = identity(from: payload) else { return nil }
        let tile = tiles[identity.attachmentId]
        return tile?.identity == identity ? tile : nil
    }

    private func attach(_ payload: [String: Any]) {
        guard let identity = identity(from: payload) else { return }
        guard tiles[identity.attachmentId] == nil else { return }
        guard let urlString = payload["url"] as? String,
              urlString.count <= WebViewTileProtocol.maxURLLength,
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            emitFailure(identity, code: "invalid_url")
            return
        }
        guard tiles.count < WebViewTileProtocol.maxTiles else {
            emitFailure(identity, code: "max_webviews")
            return
        }

        let tile = WebViewTile(
            identity: identity,
            url: url,
            externalURLHandler: externalURLHandler
        ) { [weak self] identity, event in
            switch event {
            case .loaded:
                self?.emit(type: "webview.loaded", payload: [
                    "webPaneId": identity.paneId,
                    "attachmentId": identity.attachmentId,
                ])
            case let .failed(code):
                self?.emitFailure(identity, code: code)
            }
        }
        tile.hostView.frame = overlay.bounds
        tile.hostView.autoresizingMask = [.width, .height]
        tile.hostView.isHidden = true
        overlay.addSubview(tile.hostView)
        tiles[identity.attachmentId] = tile
        sortOverlaySubviews()
        emit(type: "webview.attached", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
        ])
    }

    private func applyFrame(_ payload: [String: Any]) {
        guard let tile = tile(for: payload),
              let frame = framePayload(payload, identity: tile.identity)
        else {
            return
        }
        tile.apply(placement: placement(for: frame), frame: frame)
        sortOverlaySubviews()
    }

    private func detach(_ payload: [String: Any]) {
        guard let identity = identity(from: payload),
              let tile = tiles.removeValue(forKey: identity.attachmentId)
        else {
            return
        }
        tile.destroy()
        emit(type: "webview.detached", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
        ])
    }

    private func framePayload(_ payload: [String: Any], identity: PaneIdentity) -> PaneFramePayload? {
        guard let x = (payload["x"] as? NSNumber)?.doubleValue,
              let y = (payload["y"] as? NSNumber)?.doubleValue,
              let width = (payload["width"] as? NSNumber)?.doubleValue,
              let height = (payload["height"] as? NSNumber)?.doubleValue,
              let scale = (payload["scale"] as? NSNumber)?.doubleValue,
              let visible = payload["visible"] as? Bool,
              let order = (payload["order"] as? NSNumber)?.intValue,
              let rawRegions = payload["visibleRegions"] as? [[String: Any]],
              NativeTerminalProtocol.isValidFrameCoordinate(x),
              NativeTerminalProtocol.isValidFrameCoordinate(y),
              NativeTerminalProtocol.isValidFrameDimension(width, allowsZero: true),
              NativeTerminalProtocol.isValidFrameDimension(height, allowsZero: true),
              NativeTerminalProtocol.isValidFrameScale(scale)
        else {
            return nil
        }
        var regions: [PaneVisibleRegion] = []
        for rawRegion in rawRegions {
            guard let regionX = (rawRegion["x"] as? NSNumber)?.doubleValue,
                  let regionY = (rawRegion["y"] as? NSNumber)?.doubleValue,
                  let regionWidth = (rawRegion["width"] as? NSNumber)?.doubleValue,
                  let regionHeight = (rawRegion["height"] as? NSNumber)?.doubleValue,
                  NativeTerminalProtocol.isValidFrameCoordinate(regionX),
                  NativeTerminalProtocol.isValidFrameCoordinate(regionY),
                  NativeTerminalProtocol.isValidFrameDimension(regionWidth, allowsZero: false),
                  NativeTerminalProtocol.isValidFrameDimension(regionHeight, allowsZero: false)
            else {
                return nil
            }
            regions.append(PaneVisibleRegion(
                x: regionX,
                y: regionY,
                width: regionWidth,
                height: regionHeight
            ))
        }
        return PaneFramePayload(
            identity: identity,
            x: x,
            y: y,
            width: width,
            height: height,
            scale: scale,
            visible: visible,
            visibleRegions: regions,
            resizeOwner: false,
            order: order
        )
    }

    private func placement(for frame: PaneFramePayload) -> TerminalPlacement {
        TerminalGeometry.placement(
            for: frame,
            viewportSize: overlay.bounds.size,
            backingScale: overlay.window?.backingScaleFactor
                ?? NSScreen.main?.backingScaleFactor
                ?? CGFloat(frame.scale),
            contentScale: zoomScale
        )
    }

    private func destroyAllTiles() {
        for tile in tiles.values {
            tile.destroy()
        }
        tiles.removeAll()
    }

    private func sortOverlaySubviews() {
        overlay.sortSubviews({ left, right, _ in
            if left.tag == right.tag { return .orderedSame }
            return left.tag < right.tag ? .orderedAscending : .orderedDescending
        }, context: nil)
    }

    private func emitFailure(_ identity: PaneIdentity, code: String) {
        emit(type: "webview.failed", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
            "code": code,
        ])
    }

    private func emit(type: String, payload: [String: Any]) {
        guard let pageId, !pageId.isEmpty else { return }
        eventSequence += 1
        let event: [String: Any] = [
            "version": WebViewTileProtocol.version,
            "pageId": pageId,
            "eventSequence": eventSequence,
            "type": type,
            "payload": payload,
        ]
        if let eventObserver {
            eventObserver(event)
            return
        }
        guard let hostWebView else { return }
        hostWebView.callAsyncJavaScript(
            """
            if (typeof window.__commandoNativeWebViewReceive === "function") {
                window.__commandoNativeWebViewReceive(event);
            }
            """,
            arguments: ["event": event],
            in: nil,
            in: .page
        ) { result in
            if case let .failure(error) = result {
                NSLog("CommandoDesktop failed to deliver web view tile event: %@", String(describing: error))
            }
        }
    }
}
