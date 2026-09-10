import AppKit
import SwiftTerm

enum TerminalSurfaceEvent {
    case input(Data)
    case paste(String)
    case resize(GridSize)
    case focusChanged(Bool)
    case selectionCopied
    case contextMenu(CGPoint)
    case shortcut(String)
}

struct TerminalClipboardPolicy: Equatable, Sendable {
    let allowsOSC52Read: Bool
    let allowsOSC52Write: Bool

    static let defaultDeny = Self(allowsOSC52Read: false, allowsOSC52Write: false)

    @MainActor
    func read(from pasteboard: NSPasteboard) -> Data? {
        guard allowsOSC52Read else { return nil }
        return pasteboard.string(forType: .string)?.data(using: .utf8)
    }

    @MainActor
    func write(_ content: Data, to pasteboard: NSPasteboard) {
        guard allowsOSC52Write else { return }
        pasteboard.clearContents()
        pasteboard.setString(String(decoding: content, as: UTF8.self), forType: .string)
    }
}

enum TerminalRendererVisibilityAction: Equatable, Sendable {
    case none
    case disableMetal
    case enableMetalAndRedraw
    case redraw
}

enum TerminalRendererVisibilityPolicy {
    static func action(
        isHidden: Bool,
        prefersMetal: Bool,
        isUsingMetal: Bool
    ) -> TerminalRendererVisibilityAction {
        if isHidden {
            return isUsingMetal ? .disableMetal : .none
        }
        return prefersMetal && !isUsingMetal ? .enableMetalAndRedraw : .redraw
    }
}

enum SourceGridScrollPolicy {
    static func delta(
        horizontal: CGFloat,
        vertical: CGFloat,
        hasPreciseDeltas: Bool,
        modifiers: NSEvent.ModifierFlags,
        mouseReportingActive: Bool,
        alternateBuffer: Bool,
        scrollbackAtBottom: Bool
    ) -> CGSize? {
        guard horizontal.isFinite, vertical.isFinite else { return nil }
        let activeModifiers = modifiers.intersection([.command, .option, .control, .shift])
        let scale: CGFloat = hasPreciseDeltas ? 1 : 24

        if activeModifiers == [.option, .shift] {
            guard vertical != 0 else { return nil }
            return CGSize(width: 0, height: -vertical * scale)
        }
        guard activeModifiers.isEmpty || activeModifiers == .shift else { return nil }
        if mouseReportingActive && activeModifiers != .shift { return nil }

        if activeModifiers == .shift || abs(horizontal) > abs(vertical) {
            let source = horizontal != 0 ? horizontal : vertical
            guard source != 0 else { return nil }
            return CGSize(width: -source * scale, height: 0)
        }
        guard !alternateBuffer, vertical != 0 else { return nil }
        if vertical > 0 || scrollbackAtBottom {
            return CGSize(width: 0, height: -vertical * scale)
        }
        return nil
    }
}

@MainActor
final class TerminalSurfaceHostView: NSView {
    var hostOrderRank = 0

    override var isOpaque: Bool { false }
    override var tag: Int { hostOrderRank }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard bounds.contains(point) else { return nil }
        for subview in subviews.reversed() where !subview.isHidden {
            if let result = subview.hitTest(point) { return result }
        }
        return nil
    }

    func visuallyCovers(_ point: NSPoint) -> Bool {
        let localPoint = NSPoint(
            x: point.x - frame.minX + bounds.minX,
            y: point.y - frame.minY + bounds.minY
        )
        return subviews
            .compactMap { $0 as? TerminalBackdropView }
            .contains(where: { $0.visuallyCovers(localPoint) })
    }
}

@MainActor
final class TerminalBackdropView: NSView {
    private let visibleMask = CAShapeLayer()
    private var visibleRegions: [CGRect] = []

    override var isOpaque: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func apply(_ placement: TerminalPlacement) {
        guard !placement.isHidden,
              let visibleBounds = placement.visibleFrames.reduce(nil, { partial, frame in
                  partial?.union(frame) ?? frame
              })
        else {
            isHidden = true
            visibleRegions = []
            visibleMask.path = nil
            return
        }

        isHidden = false
        frame = visibleBounds
        visibleRegions = placement.visibleFrames.map {
            $0.offsetBy(dx: -frame.minX, dy: -frame.minY)
        }
        let path = CGMutablePath()
        visibleRegions.forEach { path.addRect($0) }
        visibleMask.frame = bounds
        visibleMask.path = path
        layer?.mask = visibleMask
    }

    func visuallyCovers(_ point: NSPoint) -> Bool {
        let localPoint = NSPoint(
            x: point.x - frame.minX + bounds.minX,
            y: point.y - frame.minY + bounds.minY
        )
        return visibleRegions.contains(where: { $0.contains(localPoint) })
    }
}

@MainActor
final class HostedTerminalView: TerminalView {
    static let maxAccessibilityValueBytes = 64 * 1_024
    static let maxAccessibilityValueLines = 200
    static let maxAccessibilitySelectionBytes = 8 * 1_024

    var shortcutWasPressed: ((String) -> Void)?
    var modifiedArrowWasPressed: ((Data) -> Void)?
    var controlVWasPressed: (() -> Void)?
    var pasteWasRequested: (() -> Void)?
    var copySelection: ((String) -> Bool)?
    var selectionWasCopied: (() -> Void)?
    var contextMenuWasRequested: ((CGPoint) -> Void)?
    var sourceGridScrollWasRequested: ((CGSize) -> Bool)?
    var hostOrderRank = 0
    private(set) var visibleHitRegions: [CGRect] = []
    private let visibleMask = CAShapeLayer()
    private var autoCopySelectionActive = false
    private var optionSelectionActive = false
    private var contextMenuViewport: CGRect?

    override var tag: Int { hostOrderRank }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    func hideEmbeddedScroller() {
        for case let scroller as NSScroller in subviews {
            scroller.isHidden = true
        }
    }

    var embeddedScrollerWidth: CGFloat {
        subviews.contains { $0 is NSScroller && !$0.isHidden }
            ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: scrollerStyle)
            : 0
    }

    func setVisibleRegions(_ regions: [CGRect], hitRegions: [CGRect]? = nil) {
        let clip = { (candidates: [CGRect]) -> [CGRect] in
            candidates.compactMap { region in
                let clipped = region.intersection(self.bounds)
                return clipped.isNull || clipped.width <= 0 || clipped.height <= 0 ? nil : clipped
            }
        }
        let visibleRegions = clip(regions)
        visibleHitRegions = hitRegions.map(clip) ?? visibleRegions
        let path = CGMutablePath()
        visibleRegions.forEach { path.addRect($0) }
        visibleMask.frame = bounds
        visibleMask.path = path
        layer?.mask = visibleMask
    }

    func setContextMenuViewport(_ viewport: CGRect?) {
        contextMenuViewport = viewport
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let localPoint = NSPoint(
            x: point.x - frame.minX + bounds.minX,
            y: point.y - frame.minY + bounds.minY
        )
        guard visibleHitRegions.contains(where: { $0.contains(localPoint) }) else { return nil }
        return super.hitTest(point)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKeyAndOrderFront(nil)
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
        window?.makeFirstResponder(self)
        let terminal = getTerminal()
        let mouseReportingActive = allowMouseReporting && terminal.mouseMode != .off
        optionSelectionActive = hasExactOptionModifier(event)
        let shiftSelectionActive = hasExactShiftModifier(event) && !terminal.mouseShiftCapture
        autoCopySelectionActive = !mouseReportingActive || optionSelectionActive || shiftSelectionActive
        if optionSelectionActive {
            withoutMouseReporting { super.mouseDown(with: event) }
        } else {
            super.mouseDown(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        if optionSelectionActive {
            withoutMouseReporting { super.mouseDragged(with: event) }
        } else {
            super.mouseDragged(with: event)
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard autoCopySelectionActive else {
            super.mouseUp(with: event)
            return
        }
        if optionSelectionActive {
            withoutMouseReporting { super.mouseUp(with: event) }
        } else {
            super.mouseUp(with: event)
        }
        autoCopySelectionActive = false
        optionSelectionActive = false
        copy(self)
    }

    override func accessibilityValue() -> Any? {
        guard isAccessibilityEnabled() else { return nil }
        let data = getTerminal().getBufferAsData(kind: .active)
        return Self.boundedAccessibilityText(
            String(decoding: data, as: UTF8.self),
            maximumBytes: Self.maxAccessibilityValueBytes,
            maximumLines: Self.maxAccessibilityValueLines
        )
    }

    override func accessibilitySelectedText() -> String? {
        guard isAccessibilityEnabled(), let selection = getSelection(), !selection.isEmpty else {
            return nil
        }
        return Self.boundedAccessibilityText(
            selection,
            maximumBytes: Self.maxAccessibilitySelectionBytes,
            maximumLines: Self.maxAccessibilityValueLines
        )
    }

    func postAccessibilityValueChanged() {
        guard isAccessibilityEnabled() else { return }
        NSAccessibility.post(element: self, notification: .valueChanged)
    }

    static func boundedAccessibilityText(
        _ text: String,
        maximumBytes: Int,
        maximumLines: Int
    ) -> String {
        guard maximumBytes > 0, maximumLines > 0 else { return "" }
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        while lines.last?.isEmpty == true { lines.removeLast() }
        let lineBounded = lines.suffix(maximumLines).joined(separator: "\n")
        guard lineBounded.utf8.count > maximumBytes else { return lineBounded }

        var byteCount = 0
        var suffix: [Character] = []
        for character in lineBounded.reversed() {
            let bytes = String(character).utf8.count
            guard byteCount + bytes <= maximumBytes else { break }
            suffix.append(character)
            byteCount += bytes
        }
        return String(suffix.reversed())
    }

    override func rightMouseDown(with event: NSEvent) {
        let viewport = contextMenuViewport ?? bounds
        guard hasExactOptionModifier(event),
              viewport.width > 0,
              viewport.height > 0
        else {
            super.rightMouseDown(with: event)
            return
        }
        window?.makeKeyAndOrderFront(nil)
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
        // Do not steal first responder here: moving focus into the terminal view
        // blurs the web page, which would dismiss the DOM context menu as it opens.
        let point = convert(event.locationInWindow, from: nil)
        contextMenuWasRequested?(CGPoint(
            x: min(1, max(0, (point.x - viewport.minX) / viewport.width)),
            y: min(1, max(0, (viewport.maxY - point.y) / viewport.height))
        ))
    }

    func handleSourceGridScroll(_ event: NSEvent) -> Bool {
        let terminal = getTerminal()
        let delta = SourceGridScrollPolicy.delta(
            horizontal: event.scrollingDeltaX,
            vertical: event.scrollingDeltaY,
            hasPreciseDeltas: event.hasPreciseScrollingDeltas,
            modifiers: event.modifierFlags,
            mouseReportingActive: allowMouseReporting && terminal.mouseMode != .off,
            alternateBuffer: terminal.isCurrentBufferAlternate,
            scrollbackAtBottom: !canScroll || scrollPosition >= 1
        )
        return delta.flatMap { sourceGridScrollWasRequested?($0) } == true
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // AppKit offers key equivalents to every view in hierarchy order, not just
        // the first responder, so an unfocused pane must let the event pass.
        guard window?.firstResponder === self else {
            return super.performKeyEquivalent(with: event)
        }
        let shortcutModifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if shortcutModifiers == .command,
           let key = event.charactersIgnoringModifiers?.lowercased() {
            if key == "c" {
                copy(self)
                return true
            }
            if key == "v" {
                paste(self)
                return true
            }
        }
        if shortcutModifiers == .command,
           let key = event.charactersIgnoringModifiers?.lowercased(),
           key == "k" || (key.count == 1 && ("1"..."9").contains(key)) {
            shortcutWasPressed?(key)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func paste(_ sender: Any) {
        guard let pasteWasRequested else {
            super.paste(sender)
            return
        }
        pasteWasRequested()
    }

    override func copy(_ sender: Any) {
        guard let selection = getSelection(), !selection.isEmpty else { return }
        let copied: Bool
        if let copySelection {
            copied = copySelection(selection)
        } else {
            super.copy(sender)
            copied = NSPasteboard.general.string(forType: .string) == selection
        }
        if copied { selectionWasCopied?() }
    }

    func handleOptionArrow(_ event: NSEvent) -> Bool {
        guard let sequence = Self.optionArrowSequence(for: event) else { return false }
        modifiedArrowWasPressed?(sequence)
        return true
    }

    func handleOptionBackspace(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard modifiers == .option, event.keyCode == 51 else { return false }

        let previousOptionAsMetaKey = optionAsMetaKey
        optionAsMetaKey = true
        defer { optionAsMetaKey = previousOptionAsMetaKey }
        keyDown(with: event)
        return true
    }

    static func optionArrowSequence(for event: NSEvent) -> Data? {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard modifiers == .option else { return nil }

        switch event.keyCode {
        case 126:
            return Data([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41])
        case 125:
            return Data([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42])
        case 124:
            return Data([0x1b, 0x66])
        case 123:
            return Data([0x1b, 0x62])
        default:
            return nil
        }
    }

    func handleControlV(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard modifiers == .control,
              event.charactersIgnoringModifiers?.lowercased() == "v"
        else {
            return false
        }
        controlVWasPressed?()
        return true
    }

    private func hasExactOptionModifier(_ event: NSEvent) -> Bool {
        event.modifierFlags.intersection([.command, .option, .control, .shift]) == .option
    }

    private func hasExactShiftModifier(_ event: NSEvent) -> Bool {
        event.modifierFlags.intersection([.command, .option, .control, .shift]) == .shift
    }

    private func withoutMouseReporting(_ operation: () -> Void) {
        let previous = allowMouseReporting
        allowMouseReporting = false
        operation()
        allowMouseReporting = previous
    }
}

@MainActor
final class TerminalSurface: NSObject, @preconcurrency TerminalViewDelegate {
    let identity: PaneIdentity
    let hostView: TerminalSurfaceHostView
    let backdropView: TerminalBackdropView
    let view: HostedTerminalView
    private(set) var latestFrame: PaneFramePayload?
    private(set) var orderKey: SurfaceOrderKey

    private let prefersMetal: Bool
    private let clipboardPolicy: TerminalClipboardPolicy
    private let pasteboard: NSPasteboard
    private let externalURLHandler: any ExternalURLHandling
    private let eventSink: (TerminalSurfaceEvent) -> Void
    private var dataOrderGate = TerminalDataOrderGate()
    private var resizeGate = ResizeEmissionGate()
    private var latestPlacement: TerminalPlacement?
    private var sourceGrid: GridSize?
    private(set) var sourceScrollOffset = CGPoint.zero
    private var scrollEventMonitor: Any?
    private var isVisible = false
    private var isResizeOwner = false
    private var suppressResize = false
    private var metalAttempted = false
    private var destroyed = false
    private var lastFocusState = false

    init(
        identity: PaneIdentity,
        ariaLabel: String,
        accessibilityEnabled: Bool = true,
        keyShortcuts: [String] = [],
        prefersMetal: Bool,
        clipboardPolicy: TerminalClipboardPolicy = .defaultDeny,
        pasteboard: NSPasteboard = .general,
        externalURLHandler: (any ExternalURLHandling)? = nil,
        eventSink: @escaping (TerminalSurfaceEvent) -> Void
    ) {
        self.identity = identity
        self.prefersMetal = prefersMetal
        self.clipboardPolicy = clipboardPolicy
        self.pasteboard = pasteboard
        self.externalURLHandler = externalURLHandler ?? SafeExternalURLHandler()
        self.eventSink = eventSink
        hostView = TerminalSurfaceHostView(frame: .zero)
        backdropView = TerminalBackdropView(frame: .zero)
        view = HostedTerminalView(frame: .zero)
        orderKey = .init(order: 0, paneId: identity.paneId, attachmentId: identity.attachmentId)
        super.init()

        hostView.autoresizingMask = [.width, .height]
        backdropView.wantsLayer = true
        backdropView.layer?.backgroundColor = TerminalProfile.backgroundColor.cgColor
        hostView.addSubview(backdropView)
        hostView.addSubview(view)
        configureView(metadata: .init(
            ariaLabel: ariaLabel,
            accessibilityEnabled: accessibilityEnabled,
            keyShortcuts: keyShortcuts
        ))
    }

    var isFocused: Bool {
        view.window?.firstResponder === view
    }

    func updateMetadata(_ metadata: PaneMetadata) {
        applyMetadata(metadata)
    }

    func setZoomScale(_ scale: CGFloat) {
        guard !destroyed,
              scale.isFinite,
              (TerminalGeometry.minContentScale...TerminalGeometry.maxContentScale).contains(scale)
        else {
            return
        }
        let preserveSourceGrid = !isResizeOwner
        let wasSuppressingResize = suppressResize
        suppressResize = true
        view.font = TerminalProfile.font(size: TerminalProfile.fontSize * scale)
        if preserveSourceGrid { restoreSourceGrid() }
        suppressResize = wasSuppressingResize
    }

    func applyFrame(
        _ payload: PaneFramePayload,
        viewportSize: CGSize,
        backingScale: CGFloat
    ) {
        guard !destroyed else { return }
        latestFrame = payload
        orderKey = .init(
            order: payload.order,
            paneId: identity.paneId,
            attachmentId: identity.attachmentId
        )

        let placement = TerminalGeometry.placement(
            for: payload,
            viewportSize: viewportSize,
            backingScale: backingScale
        )
        latestPlacement = placement
        isVisible = !placement.isHidden
        isResizeOwner = payload.resizeOwner
        if placement.isHidden || !payload.resizeOwner {
            resizeGate.reset()
        }

        let rendererAction = TerminalRendererVisibilityPolicy.action(
            isHidden: placement.isHidden,
            prefersMetal: prefersMetal,
            isUsingMetal: view.isUsingMetalRenderer
        )
        if rendererAction == .disableMetal {
            try? view.setUseMetal(false)
        }
        if placement.isHidden {
            metalAttempted = false
        }
        hostView.isHidden = placement.isHidden
        view.isHidden = placement.isHidden
        backdropView.apply(placement)
        if placement.isHidden {
            view.setVisibleRegions([])
            view.setContextMenuViewport(nil)
        } else {
            layoutView(for: placement)
            view.setVisibleRegions(
                localVisibleRegions(for: placement),
                hitRegions: localHitRegions(for: placement)
            )
        }

        switch rendererAction {
        case .enableMetalAndRedraw:
            enableMetalIfRequested()
            view.needsDisplay = true
        case .redraw:
            view.needsDisplay = true
        case .none, .disableMetal:
            break
        }
        if !placement.isHidden {
            emitCurrentResizeIfNeeded()
        }
    }

    @discardableResult
    func applyReset(_ payload: PaneResetPayload) -> Bool {
        guard !destroyed, dataOrderGate.acceptReset(revision: payload.revision) else { return false }

        suppressResize = true
        sourceGrid = .init(cols: payload.cols, rows: payload.rows)
        view.resize(cols: payload.cols, rows: payload.rows)
        view.getTerminal().resetToInitialState()
        feed(payload.data)
        if let latestPlacement, !latestPlacement.isHidden {
            layoutView(for: latestPlacement)
            view.setVisibleRegions(localVisibleRegions(for: latestPlacement))
            if isResizeOwner {
                // A reseed can arrive after the owner frame. Refit even when that frame is unchanged.
                view.setFrameSize(view.frame.size)
                let terminal = view.getTerminal()
                sourceGrid = .init(cols: terminal.cols, rows: terminal.rows)
            }
        } else {
            restoreSourceGrid()
        }
        suppressResize = false
        emitCurrentResizeIfNeeded()
        return true
    }

    @discardableResult
    func applyData(_ payload: PaneDataPayload) -> Bool {
        guard !destroyed, dataOrderGate.acceptData(revision: payload.revision) else { return false }
        feed(payload.data)
        return true
    }

    @discardableResult
    func focus() -> Bool {
        guard !destroyed, isVisible, let window = view.window else { return false }
        return window.makeFirstResponder(view)
    }

    func destroy() {
        guard !destroyed else { return }
        if lastFocusState || isFocused {
            emitFocus(false)
        }
        destroyed = true
        view.terminalDelegate = nil
        view.shortcutWasPressed = nil
        view.modifiedArrowWasPressed = nil
        view.controlVWasPressed = nil
        view.pasteWasRequested = nil
        view.copySelection = nil
        view.selectionWasCopied = nil
        view.contextMenuWasRequested = nil
        view.sourceGridScrollWasRequested = nil
        if let scrollEventMonitor { NSEvent.removeMonitor(scrollEventMonitor) }
        scrollEventMonitor = nil
        NotificationCenter.default.removeObserver(self)
        if view.isUsingMetalRenderer {
            try? view.setUseMetal(false)
        }
        hostView.removeFromSuperview()
    }

    private func configureView(metadata: PaneMetadata) {
        view.isHidden = true
        view.clipsToBounds = true
        view.terminalDelegate = self
        view.optionAsMetaKey = false
        TerminalProfile.apply(to: view)
        view.caretViewTracksFocus = true
        view.scrollerStyle = .overlay
        view.hideEmbeddedScroller()
        view.changeScrollback(5_000)
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.textArea)
        applyMetadata(metadata)
        view.shortcutWasPressed = { [weak self] key in self?.eventSink(.shortcut(key)) }
        view.modifiedArrowWasPressed = { [weak self] data in self?.emitInput(data) }
        view.controlVWasPressed = { [weak self] in
            guard let self else { return }
            _ = TerminalClipboardBridge.ensurePNGRepresentation(in: self.pasteboard)
            self.emitInput(Data([0x16]))
        }
        view.pasteWasRequested = { [weak self] in
            guard let self,
                  let text = TerminalClipboardBridge.boundedPlainText(in: self.pasteboard)
            else {
                return
            }
            self.eventSink(.paste(text))
        }
        view.copySelection = { [weak self] text in
            guard let self else { return false }
            return TerminalClipboardBridge.writePlainText(text, to: self.pasteboard)
        }
        view.selectionWasCopied = { [weak self] in
            self?.eventSink(.selectionCopied)
        }
        view.contextMenuWasRequested = { [weak self] normalizedPoint in
            guard let self,
                  self.isVisible,
                  let frame = self.latestFrame,
                  let clientPoint = TerminalGeometry.clientPoint(for: normalizedPoint, in: frame)
            else {
                return
            }
            self.eventSink(.contextMenu(clientPoint))
        }
        view.sourceGridScrollWasRequested = { [weak self] delta in
            self?.scrollSourceGrid(by: delta) ?? false
        }
        scrollEventMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            let handled = MainActor.assumeIsolated {
                guard let self,
                      self.isVisible,
                      event.window === self.view.window,
                      let superview = self.view.superview
                else {
                    return false
                }
                let point = superview.convert(event.locationInWindow, from: nil)
                guard self.view.hitTest(point) != nil else { return false }
                return self.view.handleSourceGridScroll(event)
            }
            return handled ? nil : event
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(firstResponderDidChange(_:)),
            name: .commandoFirstResponderDidChange,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowFocusDidChange(_:)),
            name: NSWindow.didBecomeKeyNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowFocusDidChange(_:)),
            name: NSWindow.didResignKeyNotification,
            object: nil
        )
    }

    private func applyMetadata(_ metadata: PaneMetadata) {
        view.setAccessibilityLabel(metadata.ariaLabel)
        view.setAccessibilityEnabled(metadata.accessibilityEnabled)
        view.setAccessibilityHelp(
            "Keyboard shortcuts: \(metadata.keyShortcuts.joined(separator: ", ")). " +
                "Option-drag selects text; Option-right-click opens pane actions; " +
                "Shift-scroll moves source columns and Option-Shift-scroll moves source rows."
        )
    }

    @objc
    private func firstResponderDidChange(_ notification: Notification) {
        guard notification.object as? NSWindow === view.window else { return }
        emitFocus(isFocused)
    }

    @objc
    private func windowFocusDidChange(_ notification: Notification) {
        guard notification.object as? NSWindow === view.window else { return }
        emitFocus(view.hasFocus)
    }

    private func enableMetalIfRequested() {
        guard prefersMetal, !metalAttempted, view.window != nil else { return }
        metalAttempted = true
        do {
            try view.setUseMetal(true)
        } catch {
            NSLog("CommandoDesktop continuing with CoreGraphics rendering: %@", String(describing: error))
        }
    }

    private func layoutView(for placement: TerminalPlacement) {
        let preserveSourceGrid = !isResizeOwner
        let wasSuppressingResize = suppressResize
        if preserveSourceGrid { suppressResize = true }
        if preserveSourceGrid, sourceGrid == nil {
            let terminal = view.getTerminal()
            sourceGrid = .init(cols: terminal.cols, rows: terminal.rows)
        }
        if preserveSourceGrid { restoreSourceGrid() }
        let sourceContentSize = view.getOptimalFrameSize().size
        let targetFrame = TerminalSourceGridLayout.frame(
            viewport: placement.frame,
            sourceContentSize: sourceContentSize,
            resizeOwner: isResizeOwner,
            maximumSurfaceSize: maximumTerminalSurfaceSize(),
            scrollOffset: sourceScrollOffset
        )
        view.frame = targetFrame
        sourceScrollOffset = isResizeOwner ? .zero : CGPoint(
            x: max(0, placement.frame.minX - targetFrame.minX),
            y: max(0, targetFrame.minY - (placement.frame.maxY - targetFrame.height))
        )
        view.setContextMenuViewport(
            placement.frame.offsetBy(dx: -view.frame.minX, dy: -view.frame.minY)
        )
        if preserveSourceGrid { restoreSourceGrid() }
        suppressResize = wasSuppressingResize
    }

    @discardableResult
    func scrollSourceGrid(by delta: CGSize) -> Bool {
        guard !destroyed, !isResizeOwner, isVisible,
              delta.width.isFinite, delta.height.isFinite,
              let latestPlacement, !latestPlacement.isHidden
        else {
            return false
        }
        let previous = sourceScrollOffset
        sourceScrollOffset = CGPoint(
            x: sourceScrollOffset.x + delta.width,
            y: sourceScrollOffset.y + delta.height
        )
        layoutView(for: latestPlacement)
        guard sourceScrollOffset != previous else { return false }
        view.setVisibleRegions(
            localVisibleRegions(for: latestPlacement),
            hitRegions: localHitRegions(for: latestPlacement)
        )
        view.needsDisplay = true
        return true
    }

    private func localVisibleRegions(for placement: TerminalPlacement) -> [CGRect] {
        placement.visibleFrames.map {
            $0.offsetBy(dx: -view.frame.minX, dy: -view.frame.minY)
        }
    }

    private func localHitRegions(for placement: TerminalPlacement) -> [CGRect] {
        placement.hitFrames.map {
            $0.offsetBy(dx: -view.frame.minX, dy: -view.frame.minY)
        }
    }

    private func restoreSourceGrid() {
        guard let sourceGrid else { return }
        let terminal = view.getTerminal()
        terminal.resize(cols: sourceGrid.cols, rows: sourceGrid.rows)
        view.sizeChanged(source: terminal)
        view.needsDisplay = true
    }

    private func maximumTerminalSurfaceSize() -> CGSize {
        let terminal = view.getTerminal()
        let optimal = view.getOptimalFrameSize().size
        let cols = max(terminal.cols, 1)
        let rows = max(terminal.rows, 1)
        let reservedScrollerWidth = view.embeddedScrollerWidth
        let cellWidth = (optimal.width - reservedScrollerWidth) / CGFloat(cols)
        let cellHeight = optimal.height / CGFloat(rows)
        guard cellWidth.isFinite, cellHeight.isFinite,
              cellWidth > 0, cellHeight > 0
        else {
            return CGSize(width: 4_096, height: 4_096)
        }
        return CGSize(
            width: min(
                TerminalGeometry.maxViewportDimension,
                max(1, cellWidth * CGFloat(NativeTerminalProtocol.maxCols) + reservedScrollerWidth)
            ),
            height: min(
                TerminalGeometry.maxViewportDimension,
                max(1, cellHeight * CGFloat(NativeTerminalProtocol.maxRows))
            )
        )
    }

    private func feed(_ data: Data) {
        let bytes = [UInt8](data)
        view.feed(byteArray: bytes[...])
        backdropView.layer?.backgroundColor = view.nativeBackgroundColor.cgColor
        view.postAccessibilityValueChanged()
    }

    private func emitFocus(_ focused: Bool) {
        guard !destroyed, focused != lastFocusState else { return }
        lastFocusState = focused
        eventSink(.focusChanged(focused))
    }

    private func emitCurrentResizeIfNeeded() {
        let terminal = view.getTerminal()
        emitResizeIfNeeded(cols: terminal.cols, rows: terminal.rows)
    }

    private func emitResizeIfNeeded(cols: Int, rows: Int) {
        guard !destroyed, !suppressResize,
              resizeGate.shouldEmit(
                  cols: cols,
                  rows: rows,
                  isVisible: isVisible,
                  isResizeOwner: isResizeOwner
              )
        else {
            return
        }
        let size = GridSize(cols: cols, rows: rows)
        sourceGrid = size
        eventSink(.resize(size))
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        emitResizeIfNeeded(cols: newCols, rows: newRows)
    }

    func setTerminalTitle(source: TerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        emitInput(Data(data))
    }

    private func emitInput(_ bytes: Data) {
        var offset = 0
        while offset < bytes.count {
            let end = min(offset + NativeTerminalProtocol.maxInputBytes, bytes.count)
            eventSink(.input(bytes.subdata(in: offset..<end)))
            offset = end
        }
    }

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        externalURLHandler.handle(URL(string: link), source: .terminalHyperlink)
    }

    func bell(source: TerminalView) {
        NSSound.beep()
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        clipboardPolicy.write(content, to: .general)
    }

    func clipboardRead(source: TerminalView) -> Data? {
        clipboardPolicy.read(from: .general)
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
