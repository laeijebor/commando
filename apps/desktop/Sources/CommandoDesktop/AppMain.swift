import AppKit

extension Notification.Name {
    static let commandoFirstResponderDidChange = Notification.Name(
        "CommandoDesktopFirstResponderDidChange"
    )
}

@MainActor
final class DesktopWindow: NSWindow {
    var zoomShortcutWasPressed: ((String) -> Void)?

    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let previous = firstResponder
        let accepted = super.makeFirstResponder(responder)
        if accepted, previous !== firstResponder {
            NotificationCenter.default.post(name: .commandoFirstResponderDidChange, object: self)
        }
        return accepted
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
            if modifiers == .command,
               let key = event.charactersIgnoringModifiers,
               key == "-" || key == "=" {
                zoomShortcutWasPressed?(key)
                return
            }
            if let terminalView = firstResponder as? HostedTerminalView,
               terminalView.handleOptionArrow(event) || terminalView.handleControlV(event) {
                return
            }
        }
        super.sendEvent(event)
    }
}

@MainActor
enum DesktopMainMenu {
    static func make(actionTarget: AnyObject? = nil) -> NSMenu {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem(title: "Commando", action: nil, keyEquivalent: "")
        let applicationMenu = NSMenu(title: "Commando")
        applicationMenu.addItem(
            withTitle: "About Commando",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "Hide Commando",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        applicationMenu.addItem(
            withTitle: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        ).keyEquivalentModifierMask = [.command, .option]
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "Quit Commando",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)

        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu(title: "File")
        let newWindowItem = fileMenu.addItem(
            withTitle: "New Window",
            action: #selector(DesktopAppDelegate.newWindow(_:)),
            keyEquivalent: "n"
        )
        newWindowItem.target = actionTarget
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: "View")
        let reloadItem = viewMenu.addItem(
            withTitle: "Reload",
            action: #selector(DesktopAppDelegate.reload(_:)),
            keyEquivalent: "r"
        )
        reloadItem.target = actionTarget
        viewMenu.addItem(.separator())
        let zoomOutItem = viewMenu.addItem(
            withTitle: "Zoom Out",
            action: #selector(DesktopAppDelegate.zoomOut(_:)),
            keyEquivalent: "-"
        )
        zoomOutItem.target = actionTarget
        let zoomInItem = viewMenu.addItem(
            withTitle: "Zoom In",
            action: #selector(DesktopAppDelegate.zoomIn(_:)),
            keyEquivalent: "="
        )
        zoomInItem.target = actionTarget
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "Zoom",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        windowMenu.addItem(.separator())
        windowMenu.addItem(
            withTitle: "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        )
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        return mainMenu
    }
}

@MainActor
protocol DesktopWebHosting: AnyObject {
    var rootView: NSView { get }
    func reload(_ sender: Any?)
    func zoomOut(_ sender: Any?)
    func zoomIn(_ sender: Any?)
    func reapplyTerminalFrames()
    func cleanUp()
}

extension DesktopWebHost: DesktopWebHosting {}

@MainActor
protocol DesktopWindowControlling: AnyObject {
    var window: NSWindow { get }
    func show()
    func reload()
    func zoomOut()
    func zoomIn()
    func reapplyTerminalFrames()
    func cleanUp()
}

@MainActor
final class DesktopWindowSession: DesktopWindowControlling {
    let window: NSWindow
    private let webHost: any DesktopWebHosting
    private var cleanedUp = false

    init(
        restoredFrame: NSRect? = nil,
        webHost: any DesktopWebHosting = DesktopWebHost()
    ) {
        self.webHost = webHost
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Commando"
        window.minSize = WindowRestorationCodec.minimumWindowSize
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.contentView = webHost.rootView
        self.window = window
        window.zoomShortcutWasPressed = { [weak self] key in
            if key == "-" {
                self?.zoomOut()
            } else {
                self?.zoomIn()
            }
        }
        if let restoredFrame {
            window.setFrame(restoredFrame, display: false)
        } else {
            window.center()
        }
    }

    func show() {
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
    }

    func reload() {
        webHost.reload(nil)
    }

    func zoomOut() {
        webHost.zoomOut(nil)
    }

    func zoomIn() {
        webHost.zoomIn(nil)
    }

    func reapplyTerminalFrames() {
        webHost.reapplyTerminalFrames()
    }

    func cleanUp() {
        guard !cleanedUp else { return }
        cleanedUp = true
        (window as? DesktopWindow)?.zoomShortcutWasPressed = nil
        webHost.cleanUp()
        window.contentView = nil
    }
}

@MainActor
final class DesktopWindowRegistry {
    private var controllers: [ObjectIdentifier: any DesktopWindowControlling] = [:]
    private var order: [ObjectIdentifier] = []

    var count: Int { controllers.count }

    var all: [any DesktopWindowControlling] {
        order.compactMap { controllers[$0] }
    }

    var last: (any DesktopWindowControlling)? {
        order.last.flatMap { controllers[$0] }
    }

    func register(_ controller: any DesktopWindowControlling) {
        let identifier = ObjectIdentifier(controller.window)
        if controllers[identifier] == nil {
            order.append(identifier)
        }
        controllers[identifier] = controller
    }

    func controller(for window: NSWindow?) -> (any DesktopWindowControlling)? {
        guard let window else { return nil }
        return controllers[ObjectIdentifier(window)]
    }

    @discardableResult
    func remove(window: NSWindow) -> (any DesktopWindowControlling)? {
        let identifier = ObjectIdentifier(window)
        order.removeAll { $0 == identifier }
        return controllers.removeValue(forKey: identifier)
    }

    func removeAll() -> [any DesktopWindowControlling] {
        let removed = all
        controllers.removeAll()
        order.removeAll()
        return removed
    }
}

@MainActor
final class DesktopAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    typealias SessionFactory = @MainActor (NSRect?) -> any DesktopWindowControlling

    let registry = DesktopWindowRegistry()
    private let sessionFactory: SessionFactory
    private let restorationStore: any WindowRestorationStoring
    private let keyWindowProvider: @MainActor () -> NSWindow?
    private let visibleFramesProvider: @MainActor () -> [NSRect]

    init(
        sessionFactory: @escaping SessionFactory = { DesktopWindowSession(restoredFrame: $0) },
        restorationStore: any WindowRestorationStoring = UserDefaultsWindowRestorationStore(),
        keyWindowProvider: @escaping @MainActor () -> NSWindow? = { NSApp.keyWindow },
        visibleFramesProvider: @escaping @MainActor () -> [NSRect] = {
            NSScreen.screens.map(\.visibleFrame)
        }
    ) {
        self.sessionFactory = sessionFactory
        self.restorationStore = restorationStore
        self.keyWindowProvider = keyWindowProvider
        self.visibleFramesProvider = visibleFramesProvider
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainMenu = DesktopMainMenu.make(actionTarget: self)
        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = mainMenu.items.first(where: { $0.title == "Window" })?.submenu
        restoreWindows()
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        handleReopen(hasVisibleWindows: flag)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        persistWindowState()
        for controller in registry.removeAll() {
            controller.window.delegate = nil
            controller.cleanUp()
        }
    }

    @objc func newWindow(_ sender: Any?) {
        _ = openWindow()
    }

    @objc func reload(_ sender: Any?) {
        activeController?.reload()
    }

    @objc func zoomOut(_ sender: Any?) {
        activeController?.zoomOut()
    }

    @objc func zoomIn(_ sender: Any?) {
        activeController?.zoomIn()
    }

    @discardableResult
    func openWindow(restoredFrame: NSRect? = nil) -> any DesktopWindowControlling {
        let controller = sessionFactory(restoredFrame)
        controller.window.delegate = self
        registry.register(controller)
        controller.show()
        return controller
    }

    func restoreWindows() {
        let frames = restorationStore.loadFrames(visibleFrames: visibleFramesProvider())
        if frames.isEmpty {
            _ = openWindow()
            return
        }
        for frame in frames {
            _ = openWindow(restoredFrame: frame)
        }
    }

    func handleReopen(hasVisibleWindows: Bool) {
        guard !hasVisibleWindows else { return }
        if let controller = activeController ?? registry.last {
            controller.show()
        } else {
            _ = openWindow()
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let controller = registry.remove(window: window)
        else {
            return
        }
        window.delegate = nil
        controller.cleanUp()
        persistWindowState()
    }

    func windowDidResize(_ notification: Notification) {
        controller(from: notification)?.reapplyTerminalFrames()
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        controller(from: notification)?.reapplyTerminalFrames()
    }

    func windowDidMove(_ notification: Notification) {
        persistWindowState()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        persistWindowState()
    }

    private var activeController: (any DesktopWindowControlling)? {
        registry.controller(for: keyWindowProvider())
    }

    private func controller(from notification: Notification) -> (any DesktopWindowControlling)? {
        registry.controller(for: notification.object as? NSWindow)
    }

    private func persistWindowState() {
        restorationStore.saveFrames(registry.all.map { $0.window.frame })
    }
}

@main
@MainActor
struct CommandoDesktopApp {
    static func main() {
        if !BundledTerminalFont.register() {
            NSLog(
                "CommandoDesktop failed to register bundled JetBrains Mono: %@",
                BundledTerminalFont.registrationFailure ?? "unknown error"
            )
        }
        let application = NSApplication.shared
        let delegate = DesktopAppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}
