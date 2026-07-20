import AppKit
import SwiftUI

struct IslandDisplayLayout: Equatable {
    let cameraGapWidth: CGFloat
    let compactSize: CGSize

    static let standard = IslandDisplayLayout(
        cameraGapWidth: 0,
        compactSize: IslandGeometry.baseCompactSize
    )
}

struct IslandGeometry {
    static let baseCompactSize = CGSize(width: 420, height: 42)
    static let expandedSize = CGSize(width: 640, height: 540)
    static let cameraClearance: CGFloat = 12
    static let compactHorizontalPadding: CGFloat = 16
    static let minimumWingWidth: CGFloat = 210

    static func displayLayout(
        leftAuxiliaryArea: CGRect?,
        rightAuxiliaryArea: CGRect?,
        safeAreaTop: CGFloat
    ) -> IslandDisplayLayout {
        guard let leftAuxiliaryArea,
              let rightAuxiliaryArea,
              rightAuxiliaryArea.minX > leftAuxiliaryArea.maxX else {
            return .standard
        }
        let cameraGapWidth = rightAuxiliaryArea.minX - leftAuxiliaryArea.maxX
            + cameraClearance * 2
        let width = max(
            baseCompactSize.width,
            cameraGapWidth + (minimumWingWidth + compactHorizontalPadding) * 2
        )
        return IslandDisplayLayout(
            cameraGapWidth: cameraGapWidth,
            compactSize: CGSize(
                width: width,
                height: max(baseCompactSize.height, safeAreaTop)
            )
        )
    }

    static func frame(
        screenFrame: CGRect,
        expanded: Bool,
        displayLayout: IslandDisplayLayout = .standard
    ) -> CGRect {
        let size = expanded
            ? CGSize(
                width: max(expandedSize.width, displayLayout.compactSize.width),
                height: expandedSize.height
            )
            : displayLayout.compactSize
        return CGRect(
            x: screenFrame.midX - size.width / 2,
            y: screenFrame.maxY - size.height,
            width: size.width,
            height: size.height
        )
    }
}

@MainActor
final class IslandLayoutModel: ObservableObject {
    @Published private(set) var display = IslandDisplayLayout.standard

    func update(_ display: IslandDisplayLayout) {
        if self.display != display { self.display = display }
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
    private let layout = IslandLayoutModel()
    private var screenObserver: NSObjectProtocol?

    init(store: CompanionStore) {
        self.store = store
        panel = IslandPanel(
            contentRect: CGRect(origin: .zero, size: IslandGeometry.baseCompactSize),
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
            layout: layout,
            onExpansionChange: { [weak self] expanded in self?.setExpanded(expanded) }
        ))
        panel.contentView?.autoresizingMask = [.width, .height]
        store.configureHoverTracking(
            panelFrame: { [weak panel] in panel?.frame },
            pointerLocation: { NSEvent.mouseLocation }
        )
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
        let displayLayout = IslandGeometry.displayLayout(
            leftAuxiliaryArea: screen.auxiliaryTopLeftArea,
            rightAuxiliaryArea: screen.auxiliaryTopRightArea,
            safeAreaTop: screen.safeAreaInsets.top
        )
        layout.update(displayLayout)
        let nextFrame = IslandGeometry.frame(
            screenFrame: screen.frame,
            expanded: expanded ?? store.isExpanded,
            displayLayout: displayLayout
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
