import AppKit
import SwiftTerm

enum TerminalSurfaceEvent {
    case input(Data)
    case resize(GridSize)
    case focusChanged(Bool)
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

@MainActor
final class HostedTerminalView: TerminalView {
    var shortcutWasPressed: ((String) -> Void)?
    var modifiedArrowWasPressed: ((Data) -> Void)?
    var controlVWasPressed: (() -> Void)?
    var hostOrderRank = 0

    override var tag: Int { hostOrderRank }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKeyAndOrderFront(nil)
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let shortcutModifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if shortcutModifiers == .command,
           let key = event.charactersIgnoringModifiers?.lowercased(),
           key == "k" || (key.count == 1 && ("1"..."9").contains(key)) {
            shortcutWasPressed?(key)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    func handleOptionArrow(_ event: NSEvent) -> Bool {
        guard let sequence = Self.optionArrowSequence(for: event) else { return false }
        modifiedArrowWasPressed?(sequence)
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
}

@MainActor
final class TerminalSurface: NSObject, @preconcurrency TerminalViewDelegate {
    let identity: PaneIdentity
    let view: HostedTerminalView
    private(set) var latestFrame: PaneFramePayload?
    private(set) var orderKey: SurfaceOrderKey

    private let prefersMetal: Bool
    private let clipboardPolicy: TerminalClipboardPolicy
    private let pasteboard: NSPasteboard
    private let eventSink: (TerminalSurfaceEvent) -> Void
    private var dataOrderGate = TerminalDataOrderGate()
    private var resizeGate = ResizeEmissionGate()
    private var isVisible = false
    private var isResizeOwner = false
    private var suppressResize = false
    private var metalAttempted = false
    private var destroyed = false
    private var lastFocusState = false

    init(
        identity: PaneIdentity,
        ariaLabel: String,
        prefersMetal: Bool,
        clipboardPolicy: TerminalClipboardPolicy = .defaultDeny,
        pasteboard: NSPasteboard = .general,
        eventSink: @escaping (TerminalSurfaceEvent) -> Void
    ) {
        self.identity = identity
        self.prefersMetal = prefersMetal
        self.clipboardPolicy = clipboardPolicy
        self.pasteboard = pasteboard
        self.eventSink = eventSink
        view = HostedTerminalView(frame: .zero)
        orderKey = .init(order: 0, paneId: identity.paneId, attachmentId: identity.attachmentId)
        super.init()

        configureView(ariaLabel: ariaLabel)
    }

    var isFocused: Bool {
        view.window?.firstResponder === view
    }

    func updateAccessibilityLabel(_ ariaLabel: String) {
        view.setAccessibilityLabel(ariaLabel)
    }

    func applyFrame(_ payload: PaneFramePayload, viewportSize: CGSize, backingScale: CGFloat) {
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
        view.isHidden = placement.isHidden
        if !placement.isHidden {
            view.frame = placement.frame
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
        view.resize(cols: payload.cols, rows: payload.rows)
        view.getTerminal().resetToInitialState()
        feed(payload.data)
        view.setFrameSize(view.frame.size)
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
        NotificationCenter.default.removeObserver(self)
        if view.isUsingMetalRenderer {
            try? view.setUseMetal(false)
        }
        view.removeFromSuperview()
    }

    private func configureView(ariaLabel: String) {
        view.isHidden = true
        view.clipsToBounds = true
        view.terminalDelegate = self
        TerminalProfile.apply(to: view)
        view.caretViewTracksFocus = true
        view.scrollerStyle = .overlay
        view.changeScrollback(5_000)
        view.setAccessibilityLabel(ariaLabel)
        view.shortcutWasPressed = { [weak self] key in self?.eventSink(.shortcut(key)) }
        view.modifiedArrowWasPressed = { [weak self] data in self?.emitInput(data) }
        view.controlVWasPressed = { [weak self] in
            guard let self else { return }
            _ = TerminalClipboardBridge.ensurePNGRepresentation(in: self.pasteboard)
            self.emitInput(Data([0x16]))
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

    private func feed(_ data: Data) {
        let bytes = [UInt8](data)
        view.feed(byteArray: bytes[...])
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
        eventSink(.resize(.init(cols: cols, rows: rows)))
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

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}

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
