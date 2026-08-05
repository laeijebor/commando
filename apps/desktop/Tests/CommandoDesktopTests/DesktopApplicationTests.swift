import AppKit
import XCTest
@testable import CommandoDesktop

@MainActor
private final class DesktopWebHostSpy: DesktopWebHosting {
    let rootView = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    private(set) var reloadCount = 0
    private(set) var zoomOutCount = 0
    private(set) var zoomInCount = 0
    private(set) var reapplyCount = 0
    private(set) var cleanUpCount = 0

    func reload(_ sender: Any?) { reloadCount += 1 }
    func zoomOut(_ sender: Any?) { zoomOutCount += 1 }
    func zoomIn(_ sender: Any?) { zoomInCount += 1 }
    func reapplyTerminalFrames() { reapplyCount += 1 }
    func cleanUp() { cleanUpCount += 1 }
}

@MainActor
private final class DesktopWindowControllerSpy: DesktopWindowControlling {
    let window: NSWindow
    let restoredFrame: NSRect?
    private(set) var showCount = 0
    private(set) var reloadCount = 0
    private(set) var zoomOutCount = 0
    private(set) var zoomInCount = 0
    private(set) var reapplyCount = 0
    private(set) var cleanUpCount = 0

    init(restoredFrame: NSRect? = nil) {
        self.restoredFrame = restoredFrame
        window = NSWindow(
            contentRect: restoredFrame ?? NSRect(x: 10, y: 20, width: 800, height: 600),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
    }

    func show() { showCount += 1 }
    func reload() { reloadCount += 1 }
    func zoomOut() { zoomOutCount += 1 }
    func zoomIn() { zoomInCount += 1 }
    func reapplyTerminalFrames() { reapplyCount += 1 }

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
        XCTAssertEqual(viewActions.map(\.title), ["Reload", "Zoom Out", "Zoom In"])
        XCTAssertEqual(viewActions.map(\.keyEquivalent), ["r", "-", "="])
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
        let second = DesktopWindowControllerSpy()

        registry.register(first)
        registry.register(second)
        registry.register(first)

        XCTAssertEqual(registry.count, 2)
        XCTAssertTrue(registry.controller(for: first.window) === first)
        XCTAssertTrue(registry.controller(for: second.window) === second)
        XCTAssertTrue(registry.last === second)
        XCTAssertTrue(registry.all[0] === first)
        XCTAssertTrue(registry.remove(window: first.window) === first)
        XCTAssertNil(registry.controller(for: first.window))
        XCTAssertEqual(registry.count, 1)
        XCTAssertEqual(registry.removeAll().count, 1)
        XCTAssertEqual(registry.count, 0)
        first.cleanUp()
        second.cleanUp()
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
        delegate.zoomOut(nil)
        delegate.zoomIn(nil)
        XCTAssertEqual(first.reloadCount, 1)
        XCTAssertEqual(first.zoomOutCount, 1)
        XCTAssertEqual(first.zoomInCount, 1)
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
        XCTAssertEqual(second.cleanUpCount, 0)
        XCTAssertEqual(delegate.registry.count, 1)
        XCTAssertEqual(store.savedFrames.last, [second.window.frame])

        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        XCTAssertEqual(first.cleanUpCount, 1)
        XCTAssertEqual(second.cleanUpCount, 1)
        XCTAssertTrue(created.allSatisfy { $0.cleanUpCount == 1 })
    }

    func testDesktopWindowSessionCleanupIsIdempotentAndReleasesItsContentView() {
        let webHost = DesktopWebHostSpy()
        let frame = NSRect(x: 30, y: 40, width: 900, height: 650)
        let session = DesktopWindowSession(restoredFrame: frame, webHost: webHost)

        session.reload()
        session.zoomOut()
        session.zoomIn()
        session.reapplyTerminalFrames()
        session.cleanUp()
        session.cleanUp()

        XCTAssertEqual(session.window.frame, frame)
        XCTAssertEqual(webHost.reloadCount, 1)
        XCTAssertEqual(webHost.zoomOutCount, 1)
        XCTAssertEqual(webHost.zoomInCount, 1)
        XCTAssertEqual(webHost.reapplyCount, 1)
        XCTAssertEqual(webHost.cleanUpCount, 1)
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

    func testWindowRoutesControlVToTheFocusedTerminal() throws {
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
        XCTAssertTrue(window.makeFirstResponder(surface.view))
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
        let commandPlus = try XCTUnwrap(keyEvent(key: "+", modifiers: [.command, .shift], keyCode: 24))

        window.sendEvent(commandMinus)
        window.sendEvent(commandEquals)
        window.sendEvent(commandPlus)

        XCTAssertEqual(shortcuts, ["-", "="])
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
