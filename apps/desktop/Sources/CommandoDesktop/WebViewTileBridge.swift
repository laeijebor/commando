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
    static let capabilities = [
        "webview.embed.v1",
        "webview.inspectAtPoint.v1",
        "webview.resolveSelectors.v1",
    ]
    static let maxURLLength = 2_048
    static let maxRequestIdLength = 64
    static let maxInspectionCoordinate = 100_000.0
    static let maxSelectorLength = 1_024
    static let maxInspectTagLength = 32
    static let maxInspectTextLength = 512
    static let maxInspectSnippetLength = 2_048
    static let maxInspectErrorLength = 256
    static let maxSelectorResolveItems = 50
    static let maxSelectorResolveBytes = 12 * 1_024
    static let maxPendingInspectionRequests = 32
    /// Tile host views sort above the terminal surfaces in the shared overlay.
    static let hostOrderBase = 1_000

    // These bodies are fixed host code. Page-derived values enter only through
    // callAsyncJavaScript argument binding, never through string interpolation.
    static let inspectAtPointScript = """
    const target = document.elementFromPoint(inspectX, inspectY);
    if (!target) return { ok: false, error: "No element at this point" };
    const escapeCss = (value) =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(value)
            : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
    const nthStep = (element) => {
        const tag = element.tagName.toLowerCase();
        const parent = element.parentElement;
        if (!parent) return tag;
        const siblings = Array.prototype.filter.call(
            parent.children,
            (child) => child.tagName === element.tagName
        );
        return siblings.length === 1
            ? tag
            : `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
    };
    const parts = [];
    let element = target;
    while (element && element.tagName.toLowerCase() !== "html") {
        if (element.id) {
            parts.unshift(`#${escapeCss(element.id)}`);
            break;
        }
        const testId = element.getAttribute("data-testid");
        if (testId) {
            parts.unshift(`${element.tagName.toLowerCase()}[data-testid="${escapeCss(testId)}"]`);
            break;
        }
        parts.unshift(nthStep(element));
        element = element.parentElement;
    }
    const rect = target.getBoundingClientRect();
    const result = {
        ok: true,
        selector: parts.join(" > ").slice(0, 1024),
        tag: target.tagName.toLowerCase().slice(0, 32),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    if (inspectGrade === "click") {
        const text = (target.textContent || "").trim();
        if (text) result.text = text.slice(0, 512);
        result.snippet = target.outerHTML.slice(0, 2048);
    }
    return result;
    """

    static let resolveSelectorsScript = """
    const anchors = [];
    for (const item of selectorItems) {
        if (anchors.length >= 50 || item.selector.startsWith("redline:")) continue;
        let element = null;
        try {
            element = document.querySelector(item.selector);
        } catch {
            continue;
        }
        if (!element || !element.isConnected) continue;
        const rect = element.getBoundingClientRect();
        if (
            !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
            !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
            rect.width <= 0 || rect.height <= 0
        ) continue;
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const x = viewportWidth > 0 ? Math.max(0, rect.x) : rect.x;
        const y = viewportHeight > 0 ? Math.max(0, rect.y) : rect.y;
        const right = viewportWidth > 0
            ? Math.min(viewportWidth, rect.x + rect.width)
            : rect.x + rect.width;
        const bottom = viewportHeight > 0
            ? Math.min(viewportHeight, rect.y + rect.height)
            : rect.y + rect.height;
        if (right <= x || bottom <= y) continue;
        anchors.push({
            noteId: item.noteId,
            rect: { x, y, width: right - x, height: bottom - y },
        });
    }
    return anchors;
    """
}

typealias WebViewTileScriptCompletion = @MainActor @Sendable (Result<Any, any Error>) -> Void
typealias WebViewTileScriptEvaluator = @MainActor (
    WKWebView,
    String,
    [String: Any],
    @escaping WebViewTileScriptCompletion
) -> Void

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
    private let scriptEvaluator: WebViewTileScriptEvaluator
    private let mask = CAShapeLayer()
    private(set) var documentRevision = 0
    private(set) var isDocumentReady = false

    init(
        identity: PaneIdentity,
        url: URL,
        externalURLHandler: any ExternalURLHandling,
        scriptEvaluator: @escaping WebViewTileScriptEvaluator,
        eventSink: @escaping (PaneIdentity, WebViewTileEvent) -> Void
    ) {
        self.identity = identity
        self.externalURLHandler = externalURLHandler
        self.scriptEvaluator = scriptEvaluator
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
        invalidateDocument()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        hostView.removeFromSuperview()
    }

    func evaluateInspection(
        script: String,
        arguments: [String: Any],
        completion: @escaping WebViewTileScriptCompletion
    ) {
        scriptEvaluator(webView, script, arguments, completion)
    }

    private func invalidateDocument() {
        documentRevision += 1
        isDocumentReady = false
    }

    func webView(
        _ webView: WKWebView,
        didStartProvisionalNavigation navigation: WKNavigation!
    ) {
        invalidateDocument()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        invalidateDocument()
    }

    func webView(
        _ webView: WKWebView,
        didFinish navigation: WKNavigation!
    ) {
        documentRevision += 1
        isDocumentReady = true
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
        invalidateDocument()
        if (error as NSError).code != NSURLErrorCancelled {
            eventSink(identity, .failed(code: "load_failed"))
        }
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: any Error
    ) {
        invalidateDocument()
        if (error as NSError).code != NSURLErrorCancelled {
            eventSink(identity, .failed(code: "load_failed"))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        invalidateDocument()
        eventSink(identity, .failed(code: "content_process_terminated"))
    }
}

@MainActor
final class WebViewTileBridge: NSObject {
    private struct InspectionRequestKey: Hashable {
        let attachmentId: String
        let requestId: String
    }

    private weak var hostWebView: WKWebView?
    private let overlay: TerminalOverlayView
    private let externalURLHandler: any ExternalURLHandling
    private let eventObserver: (([String: Any]) -> Void)?
    private let scriptEvaluator: WebViewTileScriptEvaluator
    private var pageId: String?
    private var lastSequence = 0
    private var eventSequence = 0
    private var tiles: [String: WebViewTile] = [:]
    private var pendingInspectionRequests: Set<InspectionRequestKey> = []
    private(set) var zoomScale: CGFloat = 1

    init(
        webView: WKWebView?,
        overlay: TerminalOverlayView,
        externalURLHandler: (any ExternalURLHandling)? = nil,
        scriptEvaluator: @escaping WebViewTileScriptEvaluator = { webView, script, arguments, completion in
            webView.callAsyncJavaScript(
                script,
                arguments: arguments,
                in: nil,
                in: .page,
                completionHandler: completion
            )
        },
        eventObserver: (([String: Any]) -> Void)? = nil
    ) {
        hostWebView = webView
        self.overlay = overlay
        self.externalURLHandler = externalURLHandler ?? SafeExternalURLHandler()
        self.scriptEvaluator = scriptEvaluator
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
        case "webview.inspectAtPoint":
            inspectAtPoint(payload)
        case "webview.resolveSelectors":
            resolveSelectors(payload)
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
            externalURLHandler: externalURLHandler,
            scriptEvaluator: scriptEvaluator
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

    private func inspectAtPoint(_ payload: [String: Any]) {
        guard let tile = tile(for: payload),
              let requestId = requestId(from: payload),
              let x = boundedInspectionCoordinate(payload["x"]),
              let y = boundedInspectionCoordinate(payload["y"]),
              let grade = payload["grade"] as? String,
              grade == "hover" || grade == "click"
        else {
            return
        }
        let key = InspectionRequestKey(
            attachmentId: tile.identity.attachmentId,
            requestId: requestId
        )
        guard !pendingInspectionRequests.contains(key) else { return }
        guard pendingInspectionRequests.count < WebViewTileProtocol.maxPendingInspectionRequests else {
            emitInspectResult(
                tile.identity,
                requestId: requestId,
                result: ["ok": false, "error": "Too many pending inspections"]
            )
            return
        }
        guard pendingInspectionRequests.insert(key).inserted else { return }
        guard tile.isDocumentReady, let requestPageId = pageId else {
            pendingInspectionRequests.remove(key)
            emitInspectResult(
                tile.identity,
                requestId: requestId,
                result: ["ok": false, "error": "Document is not ready"]
            )
            return
        }
        let revision = tile.documentRevision
        tile.evaluateInspection(
            script: WebViewTileProtocol.inspectAtPointScript,
            arguments: ["inspectX": x, "inspectY": y, "inspectGrade": grade]
        ) { [weak self, weak tile] result in
            guard let self else { return }
            guard self.pendingInspectionRequests.remove(key) != nil,
                  self.pageId == requestPageId,
                  let tile,
                  self.tiles[tile.identity.attachmentId] === tile,
                  tile.documentRevision == revision,
                  tile.isDocumentReady
            else {
                return
            }
            let parsed: [String: Any]
            switch result {
            case let .success(value):
                parsed = self.inspectResult(from: value)
                    ?? ["ok": false, "error": "Page returned an invalid inspect result"]
            case .failure:
                parsed = ["ok": false, "error": "Inspect failed"]
            }
            self.emitInspectResult(tile.identity, requestId: requestId, result: parsed)
        }
    }

    private func resolveSelectors(_ payload: [String: Any]) {
        guard let tile = tile(for: payload),
              let requestId = requestId(from: payload),
              let items = selectorItems(from: payload["items"])
        else {
            return
        }
        let key = InspectionRequestKey(
            attachmentId: tile.identity.attachmentId,
            requestId: requestId
        )
        guard !pendingInspectionRequests.contains(key) else { return }
        guard pendingInspectionRequests.count < WebViewTileProtocol.maxPendingInspectionRequests else {
            emitSelectorResult(
                tile.identity,
                requestId: requestId,
                error: "Too many pending inspections"
            )
            return
        }
        guard pendingInspectionRequests.insert(key).inserted else { return }
        guard tile.isDocumentReady, let requestPageId = pageId else {
            pendingInspectionRequests.remove(key)
            emitSelectorResult(
                tile.identity,
                requestId: requestId,
                error: "Document is not ready"
            )
            return
        }
        let revision = tile.documentRevision
        let requestedNoteIds = Set(items.compactMap { ($0["noteId"] as? NSNumber)?.intValue })
        tile.evaluateInspection(
            script: WebViewTileProtocol.resolveSelectorsScript,
            arguments: ["selectorItems": items]
        ) { [weak self, weak tile] result in
            guard let self else { return }
            guard self.pendingInspectionRequests.remove(key) != nil,
                  self.pageId == requestPageId,
                  let tile,
                  self.tiles[tile.identity.attachmentId] === tile,
                  tile.documentRevision == revision,
                  tile.isDocumentReady
            else {
                return
            }
            switch result {
            case let .success(value):
                guard let anchors = self.selectorAnchors(
                    from: value,
                    requestedNoteIds: requestedNoteIds
                ) else {
                    self.emitSelectorResult(
                        tile.identity,
                        requestId: requestId,
                        error: "Page returned invalid selector anchors"
                    )
                    return
                }
                self.emit(type: "webview.resolveSelectors.result", payload: [
                    "webPaneId": tile.identity.paneId,
                    "attachmentId": tile.identity.attachmentId,
                    "requestId": requestId,
                    "ok": true,
                    "anchors": anchors,
                ])
            case .failure:
                self.emitSelectorResult(
                    tile.identity,
                    requestId: requestId,
                    error: "Selector resolution failed"
                )
            }
        }
    }

    private func detach(_ payload: [String: Any]) {
        guard let identity = identity(from: payload),
              let tile = tiles.removeValue(forKey: identity.attachmentId)
        else {
            return
        }
        pendingInspectionRequests = pendingInspectionRequests.filter {
            $0.attachmentId != identity.attachmentId
        }
        tile.destroy()
        emit(type: "webview.detached", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
        ])
    }

    private func requestId(from payload: [String: Any]) -> String? {
        guard let requestId = payload["requestId"] as? String,
              !requestId.isEmpty,
              requestId.utf16.count <= WebViewTileProtocol.maxRequestIdLength,
              requestId.range(
                  of: "^[a-zA-Z0-9_-]+$",
                  options: .regularExpression
              ) != nil
        else {
            return nil
        }
        return requestId
    }

    private func boundedInspectionCoordinate(_ value: Any?) -> Double? {
        guard !(value is Bool),
              let number = value as? NSNumber,
              number.doubleValue.isFinite,
              (0...WebViewTileProtocol.maxInspectionCoordinate).contains(number.doubleValue)
        else {
            return nil
        }
        return number.doubleValue
    }

    private func selectorItems(from value: Any?) -> [[String: Any]]? {
        guard let rawItems = value as? [[String: Any]],
              !rawItems.isEmpty,
              rawItems.count <= WebViewTileProtocol.maxSelectorResolveItems
        else {
            return nil
        }
        var items: [[String: Any]] = []
        var noteIds: Set<Int> = []
        for rawItem in rawItems {
            guard !(rawItem["noteId"] is Bool),
                  let noteNumber = rawItem["noteId"] as? NSNumber,
                  noteNumber.doubleValue.isFinite,
                  noteNumber.doubleValue.rounded() == noteNumber.doubleValue,
                  noteNumber.doubleValue > 0,
                  noteNumber.doubleValue <= 9_007_199_254_740_991,
                  let noteId = Int(exactly: noteNumber.int64Value),
                  noteIds.insert(noteId).inserted,
                  let selector = rawItem["selector"] as? String,
                  !selector.isEmpty,
                  selector.utf16.count <= WebViewTileProtocol.maxSelectorLength
            else {
                return nil
            }
            items.append(["noteId": noteId, "selector": selector])
        }
        guard let encoded = try? JSONSerialization.data(withJSONObject: items),
              encoded.count <= WebViewTileProtocol.maxSelectorResolveBytes
        else {
            return nil
        }
        return items
    }

    private func inspectResult(from value: Any?) -> [String: Any]? {
        guard let result = value as? [String: Any], let ok = result["ok"] as? Bool else {
            return nil
        }
        if !ok {
            guard let error = result["error"] as? String else { return nil }
            return [
                "ok": false,
                "error": clipped(error, length: WebViewTileProtocol.maxInspectErrorLength),
            ]
        }
        guard let selector = result["selector"] as? String,
              !selector.isEmpty,
              let tag = result["tag"] as? String,
              !tag.isEmpty,
              let rect = inspectionRect(from: result["rect"]),
              result["text"] == nil || result["text"] is String,
              result["snippet"] == nil || result["snippet"] is String
        else {
            return nil
        }
        var parsed: [String: Any] = [
            "ok": true,
            "selector": clipped(selector, length: WebViewTileProtocol.maxSelectorLength),
            "tag": clipped(tag, length: WebViewTileProtocol.maxInspectTagLength),
            "rect": rect,
        ]
        if let text = result["text"] as? String {
            parsed["text"] = clipped(text, length: WebViewTileProtocol.maxInspectTextLength)
        }
        if let snippet = result["snippet"] as? String {
            parsed["snippet"] = clipped(
                snippet,
                length: WebViewTileProtocol.maxInspectSnippetLength
            )
        }
        return parsed
    }

    private func selectorAnchors(
        from value: Any?,
        requestedNoteIds: Set<Int>
    ) -> [[String: Any]]? {
        guard let rawAnchors = value as? [[String: Any]],
              rawAnchors.count <= WebViewTileProtocol.maxSelectorResolveItems
        else {
            return nil
        }
        var anchors: [[String: Any]] = []
        var seen: Set<Int> = []
        for rawAnchor in rawAnchors {
            guard !(rawAnchor["noteId"] is Bool),
                  let noteNumber = rawAnchor["noteId"] as? NSNumber,
                  noteNumber.doubleValue.rounded() == noteNumber.doubleValue,
                  let noteId = Int(exactly: noteNumber.int64Value),
                  noteId > 0,
                  requestedNoteIds.contains(noteId),
                  seen.insert(noteId).inserted,
                  let rect = inspectionRect(from: rawAnchor["rect"]),
                  let width = rect["width"] as? Double,
                  let height = rect["height"] as? Double,
                  width > 0,
                  height > 0
            else {
                return nil
            }
            anchors.append(["noteId": noteId, "rect": rect])
        }
        return anchors
    }

    private func inspectionRect(from value: Any?) -> [String: Any]? {
        guard let rect = value as? [String: Any],
              let x = finiteDouble(rect["x"]),
              let y = finiteDouble(rect["y"]),
              let width = finiteDouble(rect["width"]),
              let height = finiteDouble(rect["height"])
        else {
            return nil
        }
        return ["x": x, "y": y, "width": width, "height": height]
    }

    private func finiteDouble(_ value: Any?) -> Double? {
        guard !(value is Bool), let number = value as? NSNumber, number.doubleValue.isFinite else {
            return nil
        }
        return number.doubleValue
    }

    private func clipped(_ value: String, length: Int) -> String {
        let string = value as NSString
        return string.substring(to: min(string.length, length))
    }

    private func emitInspectResult(
        _ identity: PaneIdentity,
        requestId: String,
        result: [String: Any]
    ) {
        emit(type: "webview.inspectAtPoint.result", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
            "requestId": requestId,
            "result": result,
        ])
    }

    private func emitSelectorResult(
        _ identity: PaneIdentity,
        requestId: String,
        error: String
    ) {
        emit(type: "webview.resolveSelectors.result", payload: [
            "webPaneId": identity.paneId,
            "attachmentId": identity.attachmentId,
            "requestId": requestId,
            "ok": false,
            "error": clipped(error, length: WebViewTileProtocol.maxInspectErrorLength),
            "anchors": [],
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
        pendingInspectionRequests.removeAll()
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
