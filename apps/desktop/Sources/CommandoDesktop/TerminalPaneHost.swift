import AppKit

@MainActor
final class TerminalOverlayView: NSView {
    override var isOpaque: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard bounds.contains(point) else { return nil }
        for subview in subviews.reversed() where !subview.isHidden {
            if let result = subview.hitTest(point) { return result }
        }
        return nil
    }
}

enum PaneAttachmentResult: Equatable {
    case attached
    case alreadyAttached
    case replaced
    case capacityExceeded
}

enum TerminalFocusTransferPolicy {
    static func shouldTransfer(wasFocused: Bool, isHidden: Bool) -> Bool {
        wasFocused && isHidden
    }
}

@MainActor
final class TerminalPaneHost {
    let overlay: TerminalOverlayView
    private(set) var registry = AttachmentRegistry<TerminalSurface>(
        maximumCount: NativeTerminalProtocol.maxPanes
    )

    private weak var fallbackResponder: NSResponder?
    private let prefersMetal: Bool
    private let eventSink: (PaneIdentity, TerminalSurfaceEvent) -> Void
    private(set) var zoomScale: CGFloat = 1

    init(
        overlay: TerminalOverlayView,
        fallbackResponder: NSResponder?,
        prefersMetal: Bool,
        eventSink: @escaping (PaneIdentity, TerminalSurfaceEvent) -> Void
    ) {
        self.overlay = overlay
        self.fallbackResponder = fallbackResponder
        self.prefersMetal = prefersMetal
        self.eventSink = eventSink
    }

    var surfaceCount: Int { registry.count }

    @discardableResult
    func attach(_ payload: PaneAttachPayload) -> PaneAttachmentResult {
        if let existing = registry.record(for: payload.identity) {
            existing.value.updateMetadata(payload.metadata)
            return .alreadyAttached
        }
        guard registry.canInsert(payload.identity) else { return .capacityExceeded }

        let surface = TerminalSurface(
            identity: payload.identity,
            ariaLabel: payload.metadata.ariaLabel,
            accessibilityEnabled: payload.metadata.accessibilityEnabled,
            keyShortcuts: payload.metadata.keyShortcuts,
            prefersMetal: prefersMetal
        ) { [weak self] event in
            self?.eventSink(payload.identity, event)
        }
        surface.setZoomScale(zoomScale)
        overlay.addSubview(surface.view)
        let replaced = registry.insert(surface, for: payload.identity)
        let replacedWasFocused = replaced?.value.isFocused == true
        replaced?.value.destroy()
        reorderSurfaces()
        if replacedWasFocused {
            transferFocus(preferred: surface)
        }
        return replaced == nil ? .attached : .replaced
    }

    func update(_ payload: PaneUpdatePayload) -> Bool {
        guard let surface = registry.record(for: payload.identity)?.value else { return false }
        surface.updateMetadata(payload.metadata)
        return true
    }

    func applyFrame(_ payload: PaneFramePayload) -> Bool {
        guard let surface = registry.record(for: payload.identity)?.value else { return false }
        let wasFocused = surface.isFocused
        surface.applyFrame(
            payload,
            viewportSize: overlay.bounds.size,
            backingScale: currentBackingScale(fallback: CGFloat(payload.scale)),
            contentScale: zoomScale
        )
        reorderSurfaces()
        if TerminalFocusTransferPolicy.shouldTransfer(
            wasFocused: wasFocused,
            isHidden: surface.view.isHidden
        ) {
            focusFallbackResponder()
        }
        return true
    }

    func applyReset(_ payload: PaneResetPayload) -> Bool {
        registry.record(for: payload.identity)?.value.applyReset(payload) ?? false
    }

    func applyData(_ payload: PaneDataPayload) -> Bool {
        registry.record(for: payload.identity)?.value.applyData(payload) ?? false
    }

    func focus(_ identity: PaneIdentity) -> Bool {
        registry.record(for: identity)?.value.focus() ?? false
    }

    @discardableResult
    func detach(_ identity: PaneIdentity) -> Bool {
        guard let removed = registry.remove(identity) else { return false }
        let wasFocused = removed.value.isFocused
        removed.value.destroy()
        if wasFocused { transferFocus() }
        return true
    }

    func reapplyFrames() {
        for record in registry.records.values {
            guard let frame = record.value.latestFrame else { continue }
            let wasFocused = record.value.isFocused
            record.value.applyFrame(
                frame,
                viewportSize: overlay.bounds.size,
                backingScale: currentBackingScale(fallback: CGFloat(frame.scale)),
                contentScale: zoomScale
            )
            if TerminalFocusTransferPolicy.shouldTransfer(
                wasFocused: wasFocused,
                isHidden: record.value.view.isHidden
            ) {
                focusFallbackResponder()
            }
        }
        reorderSurfaces()
    }

    func setZoomScale(_ scale: CGFloat) {
        guard scale.isFinite, scale > 0, scale != zoomScale else { return }
        zoomScale = scale
        for record in registry.records.values {
            record.value.setZoomScale(scale)
        }
        reapplyFrames()
    }

    func destroyAll() {
        let hadFocus = registry.records.values.contains(where: { $0.value.isFocused })
        for record in registry.removeAll() {
            record.value.destroy()
        }
        if hadFocus, let window = overlay.window {
            window.makeFirstResponder(fallbackResponder)
        }
    }

    private func currentBackingScale(fallback: CGFloat) -> CGFloat {
        overlay.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? fallback
    }

    private func transferFocus(preferred: TerminalSurface? = nil) {
        if let preferred, preferred.focus() { return }
        let next = registry.records.values
            .map(\.value)
            .sorted { $0.orderKey < $1.orderKey }
            .first(where: { !$0.view.isHidden })
        if next?.focus() == true { return }
        focusFallbackResponder()
    }

    private func reorderSurfaces() {
        let ordered = registry.records.values.map(\.value).sorted { $0.orderKey < $1.orderKey }
        for (index, surface) in ordered.enumerated() {
            surface.view.hostOrderRank = index
            surface.view.layer?.zPosition = CGFloat(index)
        }
        overlay.sortSubviews({ left, right, _ in
            if left.tag == right.tag { return .orderedSame }
            return left.tag < right.tag ? .orderedAscending : .orderedDescending
        }, context: nil)
    }

    private func focusFallbackResponder() {
        overlay.window?.makeFirstResponder(fallbackResponder)
    }
}
