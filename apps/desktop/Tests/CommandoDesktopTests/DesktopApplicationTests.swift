import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
private final class FirstResponderChildView: NSView {
    override var acceptsFirstResponder: Bool { true }
}

@MainActor
private final class DesktopWebHostSpy: DesktopWebHosting {
    let rootView = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    private(set) var reloadCount = 0
    private(set) var appliedZoomPercents: [Int] = []
    private(set) var reapplyCount = 0
    private(set) var cleanUpCount = 0
    private(set) var windowActivity: [Bool] = []
    private(set) var detachedWebPaneIds: [[String]] = []

    func reload(_ sender: Any?) { reloadCount += 1 }
    func applyZoomPercent(_ percent: Int) { appliedZoomPercents.append(percent) }
    func reapplyTerminalFrames() { reapplyCount += 1 }
    func setWindowActive(_ active: Bool) { windowActivity.append(active) }
    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?) {}
    func setDetachedWebPaneIds(_ webPaneIds: [String]) { detachedWebPaneIds.append(webPaneIds) }
    func cleanUp() { cleanUpCount += 1 }
}

@MainActor
private final class DesktopWindowControllerSpy: DesktopWindowControlling {
    let window: NSWindow
    let role: DesktopWindowRole
    let restoredFrame: NSRect?
    private(set) var showCount = 0
    private(set) var closeCount = 0
    private(set) var reloadCount = 0
    private(set) var appliedZoomPercents: [Int] = []
    private(set) var reapplyCount = 0
    private(set) var cleanUpCount = 0
    private(set) var windowActivity: [Bool] = []
    private(set) var detachedWebPaneIds: [[String]] = []
    private(set) weak var windowCommandHandler: (any DesktopWindowCommandHandling)?

    init(restoredFrame: NSRect? = nil, role: DesktopWindowRole = .workspace) {
        self.restoredFrame = restoredFrame
        self.role = role
        window = NSWindow(
            contentRect: restoredFrame ?? NSRect(x: 10, y: 20, width: 800, height: 600),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
    }

    func show() { showCount += 1 }
    func close() { closeCount += 1 }
    func reload() { reloadCount += 1 }
    func applyZoomPercent(_ percent: Int) { appliedZoomPercents.append(percent) }
    func reapplyTerminalFrames() { reapplyCount += 1 }
    func setWindowActive(_ active: Bool) { windowActivity.append(active) }
    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?) {
        windowCommandHandler = handler
    }
    func setDetachedWebPaneIds(_ webPaneIds: [String]) { detachedWebPaneIds.append(webPaneIds) }

    func cleanUp() {
        cleanUpCount += 1
        window.delegate = nil
        window.orderOut(nil)
    }
}

@MainActor
private final class WindowRestorationStoreSpy: WindowRestorationStoring {
    var framesToLoad: [NSRect] = []
    private(set) var requestedVisibleFrames: [[NSRect]] = []
    private(set) var savedFrames: [[NSRect]] = []

    func loadFrames(visibleFrames: [NSRect]) -> [NSRect] {
        requestedVisibleFrames.append(visibleFrames)
        return framesToLoad
    }

    func saveFrames(_ frames: [NSRect]) {
        savedFrames.append(frames)
    }
}

@MainActor
private final class ZoomPreferenceStoreSpy: ZoomPreferenceStoring {
    var percentToLoad = ZoomPreference.defaultPercent
    private(set) var savedPercents: [Int] = []

    func loadZoomPercent() -> Int { percentToLoad }
    func saveZoomPercent(_ percent: Int) { savedPercents.append(percent) }
}

@MainActor
private final class KeyWindowProviderSpy {
    var window: NSWindow?
}

@MainActor
final class DesktopApplicationTests: XCTestCase {
    func testMainMenuProvidesNewWindowReloadZoomAndStandardWindowActions() throws {
        let actionTarget = NSObject()
        let menu = DesktopMainMenu.make(actionTarget: actionTarget)

        XCTAssertEqual(menu.items.map(\.title), ["Commando", "File", "Edit", "View", "Window"])
        let applicationMenu = try XCTUnwrap(menu.items[0].submenu)
        XCTAssertEqual(applicationMenu.items.first?.title, "About Commando")
        XCTAssertEqual(applicationMenu.items.last?.title, "Quit Commando")

        let fileMenu = try XCTUnwrap(menu.items[1].submenu)
        let newWindow = try XCTUnwrap(fileMenu.item(withTitle: "New Window"))
        XCTAssertEqual(newWindow.keyEquivalent, "n")
        XCTAssertEqual(newWindow.action, #selector(DesktopAppDelegate.newWindow(_:)))
        XCTAssertTrue(newWindow.target === actionTarget)
        let closeWindow = try XCTUnwrap(fileMenu.item(withTitle: "Close Window"))
        XCTAssertEqual(closeWindow.keyEquivalent, "w")
        XCTAssertEqual(closeWindow.action, #selector(NSWindow.performClose(_:)))

        let editMenu = try XCTUnwrap(menu.items[2].submenu)
        XCTAssertEqual(editMenu.items.map(\.title), ["Copy", "Paste"])

        let viewMenu = try XCTUnwrap(menu.items[3].submenu)
        let viewActions = viewMenu.items.filter { !$0.isSeparatorItem }
        XCTAssertEqual(viewActions.map(\.title), ["Reload", "Zoom Out", "Zoom In", "Actual Size"])
        XCTAssertEqual(viewActions.map(\.keyEquivalent), ["r", "-", "=", "0"])
        XCTAssertEqual(viewActions[3].action, #selector(DesktopAppDelegate.actualSize(_:)))
        XCTAssertTrue(viewActions.allSatisfy { $0.keyEquivalentModifierMask == .command })
        XCTAssertTrue(viewActions.allSatisfy { $0.target === actionTarget })
        XCTAssertEqual(viewActions[0].action, #selector(DesktopAppDelegate.reload(_:)))

        let windowMenu = try XCTUnwrap(menu.items[4].submenu)
        XCTAssertEqual(
            windowMenu.items.filter { !$0.isSeparatorItem }.map(\.title),
            ["Minimize", "Zoom", "Bring All to Front"]
        )
        XCTAssertEqual(windowMenu.item(withTitle: "Minimize")?.keyEquivalent, "m")
        XCTAssertEqual(
            windowMenu.item(withTitle: "Bring All to Front")?.action,
            #selector(NSApplication.arrangeInFront(_:))
        )
    }

    func testWindowRegistryTracksControllersByWindowAndPreservesOrder() {
        let registry = DesktopWindowRegistry()
        let first = DesktopWindowControllerSpy()
        let second = DesktopWindowControllerSpy(role: .webPane(id: "w-abcd1234"))

        registry.register(first)
        registry.register(second)
        registry.register(first)

        XCTAssertEqual(registry.count, 2)
        XCTAssertTrue(registry.controller(for: first.window) === first)
        XCTAssertTrue(registry.controller(for: second.window) === second)
        XCTAssertTrue(registry.last === second)
        XCTAssertTrue(registry.lastWorkspace === first)
        XCTAssertEqual(registry.detachedWebPaneIds, ["w-abcd1234"])
        XCTAssertTrue(registry.controller(forWebPaneId: "w-abcd1234") === second)
        XCTAssertTrue(registry.all[0] === first)
        XCTAssertTrue(registry.remove(window: first.window) === first)
        XCTAssertNil(registry.controller(for: first.window))
        XCTAssertEqual(registry.count, 1)
        XCTAssertEqual(registry.removeAll().count, 1)
        XCTAssertEqual(registry.count, 0)
        first.cleanUp()
        second.cleanUp()
    }

    func testDetachedWebPaneWindowsAreUniqueFocusableAndReattachWithoutDeletingPane() {
        var detached: [DesktopWindowControllerSpy] = []
        let delegate = DesktopAppDelegate(
            sessionFactory: { DesktopWindowControllerSpy(restoredFrame: $0) },
            detachedSessionFactory: { webPaneId in
                let controller = DesktopWindowControllerSpy(role: .webPane(id: webPaneId))
                detached.append(controller)
                return controller
            },
            restorationStore: WindowRestorationStoreSpy(),
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )
        let workspace = delegate.openWindow() as! DesktopWindowControllerSpy

        delegate.openWebPaneWindow(webPaneId: "w-abcd1234")
        delegate.openWebPaneWindow(webPaneId: "w-abcd1234")
        delegate.focusWebPaneWindow(webPaneId: "w-abcd1234")

        XCTAssertEqual(detached.count, 1)
        XCTAssertEqual(detached[0].showCount, 3)
        XCTAssertEqual(workspace.detachedWebPaneIds.last, ["w-abcd1234"])
        XCTAssertEqual(detached[0].detachedWebPaneIds.last, ["w-abcd1234"])
        XCTAssertTrue(workspace.windowCommandHandler === delegate)
        XCTAssertTrue(detached[0].windowCommandHandler === delegate)

        delegate.reattachWebPaneWindow(webPaneId: "w-abcd1234")
        XCTAssertEqual(detached[0].closeCount, 1)

        delegate.windowWillClose(Notification(
            name: NSWindow.willCloseNotification,
            object: detached[0].window
        ))
        XCTAssertEqual(workspace.detachedWebPaneIds.last, [])
        XCTAssertEqual(delegate.registry.count, 1)
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testRejectsMalformedDetachedWebPaneIds() {
        var detachedCount = 0
        let delegate = DesktopAppDelegate(
            detachedSessionFactory: { _ in
                detachedCount += 1
                return DesktopWindowControllerSpy()
            },
            restorationStore: WindowRestorationStoreSpy(),
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )

        delegate.openWebPaneWindow(webPaneId: "not-a-pane")

        XCTAssertEqual(detachedCount, 0)
    }

    func testMenuActionsRouteToTheKeyWindowAndNewWindowCreatesAnIndependentSession() {
        var created: [DesktopWindowControllerSpy] = []
        let keyWindow = KeyWindowProviderSpy()
        let store = WindowRestorationStoreSpy()
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            restorationStore: store,
            keyWindowProvider: { keyWindow.window },
            visibleFramesProvider: { [] }
        )
        let first = delegate.openWindow() as! DesktopWindowControllerSpy
        let second = delegate.openWindow() as! DesktopWindowControllerSpy

        keyWindow.window = first.window
        delegate.reload(nil)
        XCTAssertEqual(first.reloadCount, 1)
        XCTAssertEqual(second.reloadCount, 0)

        keyWindow.window = second.window
        delegate.reload(nil)
        XCTAssertEqual(first.reloadCount, 1)
        XCTAssertEqual(second.reloadCount, 1)

        delegate.newWindow(nil)
        XCTAssertEqual(created.count, 3)
        XCTAssertEqual(delegate.registry.count, 3)
        XCTAssertEqual(created[2].showCount, 1)
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testStoredZoomIsAppliedToRestoredAndLaterWindows() {
        var created: [DesktopWindowControllerSpy] = []
        let restorationStore = WindowRestorationStoreSpy()
        restorationStore.framesToLoad = [NSRect(x: 0, y: 0, width: 900, height: 700)]
        let zoomStore = ZoomPreferenceStoreSpy()
        zoomStore.percentToLoad = 130
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            detachedSessionFactory: { webPaneId in
                let controller = DesktopWindowControllerSpy(role: .webPane(id: webPaneId))
                created.append(controller)
                return controller
            },
            restorationStore: restorationStore,
            zoomStore: zoomStore,
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )

        delegate.restoreWindows()
        delegate.newWindow(nil)
        delegate.openWebPaneWindow(webPaneId: "w-abcd1234")

        XCTAssertEqual(created.count, 3)
        XCTAssertTrue(created.allSatisfy { $0.appliedZoomPercents == [130] })
        XCTAssertEqual(zoomStore.savedPercents, [])
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testZoomCommandsRetuneEveryWindowAndPersistImmediately() {
        var created: [DesktopWindowControllerSpy] = []
        let zoomStore = ZoomPreferenceStoreSpy()
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            detachedSessionFactory: { webPaneId in
                let controller = DesktopWindowControllerSpy(role: .webPane(id: webPaneId))
                created.append(controller)
                return controller
            },
            restorationStore: WindowRestorationStoreSpy(),
            zoomStore: zoomStore,
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )
        _ = delegate.openWindow()
        delegate.openWebPaneWindow(webPaneId: "w-abcd1234")

        delegate.zoomIn(nil)

        XCTAssertEqual(created.count, 2)
        XCTAssertTrue(created.allSatisfy { $0.appliedZoomPercents == [100, 110] })
        XCTAssertEqual(zoomStore.savedPercents, [110])

        for _ in 0..<20 { delegate.zoomIn(nil) }
        XCTAssertEqual(zoomStore.savedPercents.last, ZoomPreference.maximumPercent)
        let savedAtCeiling = zoomStore.savedPercents.count
        delegate.zoomIn(nil)
        XCTAssertEqual(zoomStore.savedPercents.count, savedAtCeiling)
        XCTAssertEqual(created[0].appliedZoomPercents.last, ZoomPreference.maximumPercent)

        delegate.actualSize(nil)
        XCTAssertEqual(zoomStore.savedPercents.last, 100)
        XCTAssertTrue(created.allSatisfy { $0.appliedZoomPercents.last == 100 })
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testWindowClosureCleansOnlyItsOwnWebHostAndPersistsRemainingFrames() {
        var created: [DesktopWindowControllerSpy] = []
        let store = WindowRestorationStoreSpy()
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            restorationStore: store,
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )
        let first = delegate.openWindow() as! DesktopWindowControllerSpy
        let second = delegate.openWindow() as! DesktopWindowControllerSpy

        delegate.windowWillClose(Notification(
            name: NSWindow.willCloseNotification,
            object: first.window
        ))

        XCTAssertEqual(first.cleanUpCount, 1)
        XCTAssertEqual(first.windowActivity, [false])
        XCTAssertEqual(second.cleanUpCount, 0)
        XCTAssertEqual(delegate.registry.count, 1)
        XCTAssertEqual(store.savedFrames.last, [second.window.frame])

        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        XCTAssertEqual(first.cleanUpCount, 1)
        XCTAssertEqual(second.cleanUpCount, 1)
        XCTAssertTrue(created.allSatisfy { $0.cleanUpCount == 1 })
    }

    func testDetachedWindowsAreExcludedFromWorkspaceRestoration() {
        let store = WindowRestorationStoreSpy()
        let delegate = DesktopAppDelegate(
            sessionFactory: { DesktopWindowControllerSpy(restoredFrame: $0) },
            detachedSessionFactory: {
                DesktopWindowControllerSpy(role: .webPane(id: $0))
            },
            restorationStore: store,
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )
        let workspace = delegate.openWindow() as! DesktopWindowControllerSpy
        delegate.openWebPaneWindow(webPaneId: "w-abcd1234")

        delegate.windowDidMove(Notification(
            name: NSWindow.didMoveNotification,
            object: workspace.window
        ))

        XCTAssertEqual(store.savedFrames.last, [workspace.window.frame])
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testKeyWindowNotificationsPublishActivityOnlyToTheirSession() {
        var created: [DesktopWindowControllerSpy] = []
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            restorationStore: WindowRestorationStoreSpy(),
            keyWindowProvider: { nil },
            visibleFramesProvider: { [] }
        )
        let first = delegate.openWindow() as! DesktopWindowControllerSpy
        let second = delegate.openWindow() as! DesktopWindowControllerSpy

        delegate.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: first.window))
        delegate.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification, object: first.window))

        XCTAssertEqual(first.windowActivity, [true, false])
        XCTAssertTrue(second.windowActivity.isEmpty)
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        XCTAssertEqual(second.windowActivity, [false])
        XCTAssertEqual(created.count, 2)
    }

    func testDesktopWindowSessionCleanupIsIdempotentAndReleasesItsContentView() {
        let webHost = DesktopWebHostSpy()
        let frame = NSRect(x: 30, y: 40, width: 900, height: 650)
        let session = DesktopWindowSession(restoredFrame: frame, webHost: webHost)

        session.reload()
        session.applyZoomPercent(120)
        session.reapplyTerminalFrames()
        session.cleanUp()
        session.cleanUp()

        XCTAssertEqual(session.window.frame, frame)
        XCTAssertEqual(webHost.reloadCount, 1)
        XCTAssertEqual(webHost.appliedZoomPercents, [120])
        XCTAssertEqual(webHost.reapplyCount, 1)
        XCTAssertEqual(webHost.cleanUpCount, 1)
        XCTAssertEqual(webHost.windowActivity, [false])
        XCTAssertNil(session.window.contentView)
        XCTAssertFalse(session.window.isRestorable)
        session.window.orderOut(nil)
    }

    func testRestoresWindowCountAndFramesAndDockReopenShowsOrCreatesAWindow() {
        let firstFrame = NSRect(x: 10, y: 20, width: 800, height: 600)
        let secondFrame = NSRect(x: 100, y: 120, width: 900, height: 700)
        let visibleFrame = NSRect(x: 0, y: 0, width: 1_920, height: 1_080)
        let store = WindowRestorationStoreSpy()
        store.framesToLoad = [firstFrame, secondFrame]
        var created: [DesktopWindowControllerSpy] = []
        let delegate = DesktopAppDelegate(
            sessionFactory: { frame in
                let controller = DesktopWindowControllerSpy(restoredFrame: frame)
                created.append(controller)
                return controller
            },
            restorationStore: store,
            keyWindowProvider: { nil },
            visibleFramesProvider: { [visibleFrame] }
        )

        delegate.restoreWindows()

        XCTAssertEqual(created.map(\.restoredFrame), [firstFrame, secondFrame])
        XCTAssertEqual(delegate.registry.count, 2)
        XCTAssertEqual(store.requestedVisibleFrames, [[visibleFrame]])
        delegate.handleReopen(hasVisibleWindows: false)
        XCTAssertEqual(created[1].showCount, 2)
        delegate.handleReopen(hasVisibleWindows: true)
        XCTAssertEqual(created[1].showCount, 2)

        for controller in created {
            delegate.windowWillClose(Notification(
                name: NSWindow.willCloseNotification,
                object: controller.window
            ))
        }
        delegate.handleReopen(hasVisibleWindows: false)
        XCTAssertEqual(created.count, 3)
        XCTAssertEqual(delegate.registry.count, 1)
        XCTAssertFalse(delegate.applicationShouldTerminateAfterLastWindowClosed(NSApplication.shared))
        XCTAssertTrue(delegate.applicationSupportsSecureRestorableState(NSApplication.shared))
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    }

    func testWindowRoutesControlVThroughTheFocusedTerminalResponderChain() throws {
        var inputs: [Data] = []
        let pasteboard = NSPasteboard(name: .init("CommandoDesktopTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("text", forType: .string)
        defer { pasteboard.clearContents() }
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "window-control-v"),
            ariaLabel: "Terminal",
            prefersMetal: false,
            pasteboard: pasteboard
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(surface.view)
        let child = FirstResponderChildView(frame: .zero)
        surface.view.addSubview(child)
        XCTAssertTrue(window.makeFirstResponder(child))
        let controlV = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .control,
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))

        window.sendEvent(controlV)

        XCTAssertEqual(inputs, [Data([0x16])])
        _ = window.makeFirstResponder(nil)
        surface.destroy()
        window.contentView = nil
        window.orderOut(nil)
    }

    func testWindowRoutesOptionLeftAndRightAsWordNavigation() throws {
        var inputs: [Data] = []
        let surface = TerminalSurface(
            identity: .init(paneId: "%1", attachmentId: "window-option-arrows"),
            ariaLabel: "Terminal",
            prefersMetal: false
        ) { event in
            if case let .input(data) = event { inputs.append(data) }
        }
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView?.addSubview(surface.view)
        XCTAssertTrue(window.makeFirstResponder(surface.view))
        let optionLeft = try XCTUnwrap(keyEvent(key: "", modifiers: .option, keyCode: 123))
        let optionRight = try XCTUnwrap(keyEvent(key: "", modifiers: .option, keyCode: 124))

        window.sendEvent(optionLeft)
        window.sendEvent(optionRight)

        XCTAssertEqual(inputs, [Data([0x1b, 0x62]), Data([0x1b, 0x66])])
        _ = window.makeFirstResponder(nil)
        surface.destroy()
        window.contentView = nil
        window.orderOut(nil)
    }

    func testWindowRoutesOnlyUnshiftedCommandZoomShortcuts() throws {
        var shortcuts: [String] = []
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.zoomShortcutWasPressed = { shortcuts.append($0) }
        let commandMinus = try XCTUnwrap(keyEvent(key: "-", modifiers: .command, keyCode: 27))
        let commandEquals = try XCTUnwrap(keyEvent(key: "=", modifiers: .command, keyCode: 24))
        let commandZero = try XCTUnwrap(keyEvent(key: "0", modifiers: .command, keyCode: 29))
        let commandPlus = try XCTUnwrap(keyEvent(key: "+", modifiers: [.command, .shift], keyCode: 24))

        window.sendEvent(commandMinus)
        window.sendEvent(commandEquals)
        window.sendEvent(commandZero)
        window.sendEvent(commandPlus)

        XCTAssertEqual(shortcuts, ["-", "=", "0"])
        window.zoomShortcutWasPressed = nil
        window.orderOut(nil)
    }

    private func keyEvent(
        key: String,
        modifiers: NSEvent.ModifierFlags,
        keyCode: UInt16
    ) -> NSEvent? {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: key,
            charactersIgnoringModifiers: key,
            isARepeat: false,
            keyCode: keyCode
        )
    }
}
