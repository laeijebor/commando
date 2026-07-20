import AppKit
import SwiftUI

struct IslandGeometry {
    static let compactSize = CGSize(width: 420, height: 42)
    static let expandedSize = CGSize(width: 640, height: 540)

    static func frame(screenFrame: CGRect, expanded: Bool) -> CGRect {
        let size = expanded ? expandedSize : compactSize
        return CGRect(
            x: screenFrame.midX - size.width / 2,
            y: screenFrame.maxY - size.height,
            width: size.width,
            height: size.height
        )
    }
}

private final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class IslandPanelController {
    private let store: CompanionStore
    private let panel: IslandPanel
    private var screenObserver: NSObjectProtocol?

    init(store: CompanionStore) {
        self.store = store
        panel = IslandPanel(
            contentRect: CGRect(origin: .zero, size: IslandGeometry.compactSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.sharingType = .readOnly
        panel.animationBehavior = .utilityWindow
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        panel.contentView = NSHostingView(rootView: IslandRootView(
            store: store,
            onExpansionChange: { [weak self] expanded in self?.setExpanded(expanded) }
        ))
        panel.contentView?.autoresizingMask = [.width, .height]
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.placePanel(animated: false) }
        }
    }

    func show() {
        placePanel(animated: false)
        panel.orderFrontRegardless()
        panel.contentView?.needsLayout = true
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.displayIfNeeded()
    }

    func toggle() {
        if !panel.isVisible { show() }
        store.toggleExpanded()
        panel.orderFrontRegardless()
    }

    private func setExpanded(_ expanded: Bool) {
        placePanel(animated: true, expanded: expanded)
        if expanded { panel.makeKeyAndOrderFront(nil) }
        else { panel.orderFrontRegardless() }
    }

    private func placePanel(animated: Bool, expanded: Bool? = nil) {
        let screen = targetScreen()
        let nextFrame = IslandGeometry.frame(
            screenFrame: screen.frame,
            expanded: expanded ?? store.isExpanded
        )
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                panel.animator().setFrame(nextFrame, display: true)
            }
        } else {
            panel.setFrame(nextFrame, display: true)
        }
    }

    private func targetScreen() -> NSScreen {
        if panel.isVisible, let current = panel.screen { return current }
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(pointer) })
            ?? NSScreen.main
            ?? NSScreen.screens[0]
    }
}
