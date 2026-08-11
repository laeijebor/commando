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
               key == "-" || key == "=" || key == "0" {
                zoomShortcutWasPressed?(key)
                return
            }
            if let terminalView = focusedTerminalView(),
               terminalView.handleOptionBackspace(event) ||
               terminalView.handleOptionArrow(event) ||
               terminalView.handleControlV(event) {
                return
            }
        }
        super.sendEvent(event)
    }

    private func focusedTerminalView() -> HostedTerminalView? {
        var responder = firstResponder
        while let current = responder {
            if let terminalView = current as? HostedTerminalView {
                return terminalView
            }
            responder = current.nextResponder
        }
        return nil
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
        fileMenu.addItem(
            withTitle: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
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
        let actualSizeItem = viewMenu.addItem(
            withTitle: "Actual Size",
            action: #selector(DesktopAppDelegate.actualSize(_:)),
            keyEquivalent: "0"
        )
        actualSizeItem.target = actionTarget
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
    func applyZoomPercent(_ percent: Int)
    func reapplyTerminalFrames()
    func setWindowActive(_ active: Bool)
    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?)
    func setDetachedWebPaneIds(_ webPaneIds: [String])
    func cleanUp()
}

extension DesktopWebHost: DesktopWebHosting {}

@MainActor
protocol DesktopWindowControlling: AnyObject {
    var window: NSWindow { get }
    var role: DesktopWindowRole { get }
    func show()
    func close()
    func reload()
    func applyZoomPercent(_ percent: Int)
    func reapplyTerminalFrames()
    func setWindowActive(_ active: Bool)
    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?)
    func setDetachedWebPaneIds(_ webPaneIds: [String])
    func cleanUp()
}

@MainActor
final class DesktopWindowSession: DesktopWindowControlling {
    let window: NSWindow
    let role: DesktopWindowRole
    private let webHost: any DesktopWebHosting
    private weak var commandHandler: (any DesktopWindowCommandHandling)?
    private var cleanedUp = false

    init(
        restoredFrame: NSRect? = nil,
        role: DesktopWindowRole = .workspace,
        webHost: (any DesktopWebHosting)? = nil
    ) {
        self.role = role
        let webHost = webHost ?? DesktopWebHost(role: role)
        self.webHost = webHost
        let defaultSize = role.webPaneId == nil
            ? NSSize(width: 1_180, height: 760)
            : NSSize(width: 960, height: 680)
        let window = DesktopWindow(
            contentRect: NSRect(origin: .zero, size: defaultSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = role.webPaneId == nil ? "Commando" : "Commando Web Pane"
        window.minSize = role.webPaneId == nil
            ? WindowRestorationCodec.minimumWindowSize
            : NSSize(width: 480, height: 320)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.contentView = webHost.rootView
        self.window = window
        window.zoomShortcutWasPressed = { [weak self] key in
            switch key {
            case "-": self?.commandHandler?.zoomOut()
            case "0": self?.commandHandler?.actualSize()
            default: self?.commandHandler?.zoomIn()
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

    func close() {
        window.performClose(nil)
    }

    func reload() {
        webHost.reload(nil)
    }

    func applyZoomPercent(_ percent: Int) {
        webHost.applyZoomPercent(percent)
    }

    func reapplyTerminalFrames() {
        webHost.reapplyTerminalFrames()
    }

    func setWindowActive(_ active: Bool) {
        webHost.setWindowActive(active)
    }

    func setWindowCommandHandler(_ handler: (any DesktopWindowCommandHandling)?) {
        commandHandler = handler
        webHost.setWindowCommandHandler(handler)
    }

    func setDetachedWebPaneIds(_ webPaneIds: [String]) {
        webHost.setDetachedWebPaneIds(webPaneIds)
    }

    func cleanUp() {
        guard !cleanedUp else { return }
        cleanedUp = true
        commandHandler = nil
        (window as? DesktopWindow)?.zoomShortcutWasPressed = nil
        webHost.setWindowActive(false)
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

    var lastWorkspace: (any DesktopWindowControlling)? {
        all.last { $0.role == .workspace }
    }

    var detachedWebPaneIds: [String] {
        all.compactMap(\.role.webPaneId).sorted()
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

    func controller(forWebPaneId webPaneId: String) -> (any DesktopWindowControlling)? {
        all.first { $0.role.webPaneId == webPaneId }
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
final class DesktopAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    DesktopWindowCommandHandling {
    typealias SessionFactory = @MainActor (NSRect?) -> any DesktopWindowControlling
    typealias DetachedSessionFactory = @MainActor (String) -> any DesktopWindowControlling

    let registry = DesktopWindowRegistry()
    private let sessionFactory: SessionFactory
    private let detachedSessionFactory: DetachedSessionFactory
    private let restorationStore: any WindowRestorationStoring
    private let zoomStore: any ZoomPreferenceStoring
    private let keyWindowProvider: @MainActor () -> NSWindow?
    private let visibleFramesProvider: @MainActor () -> [NSRect]
    private var zoomPercent: Int

    init(
        sessionFactory: @escaping SessionFactory = { DesktopWindowSession(restoredFrame: $0) },
        detachedSessionFactory: @escaping DetachedSessionFactory = {
            DesktopWindowSession(role: .webPane(id: $0))
        },
        restorationStore: any WindowRestorationStoring = UserDefaultsWindowRestorationStore(),
        zoomStore: any ZoomPreferenceStoring = UserDefaultsZoomPreferenceStore(),
        keyWindowProvider: @escaping @MainActor () -> NSWindow? = { NSApp.keyWindow },
        visibleFramesProvider: @escaping @MainActor () -> [NSRect] = {
            NSScreen.screens.map(\.visibleFrame)
        }
    ) {
        self.sessionFactory = sessionFactory
        self.detachedSessionFactory = detachedSessionFactory
        self.restorationStore = restorationStore
        self.zoomStore = zoomStore
        self.keyWindowProvider = keyWindowProvider
        self.visibleFramesProvider = visibleFramesProvider
        zoomPercent = ZoomPreference.sanitize(zoomStore.loadZoomPercent())
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
            controller.setWindowActive(false)
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
        zoomOut()
    }

    @objc func zoomIn(_ sender: Any?) {
        zoomIn()
    }

    @objc func actualSize(_ sender: Any?) {
        actualSize()
    }

    func zoomOut() {
        setZoomPercent(ZoomPreference.zoomedOut(from: zoomPercent))
    }

    func zoomIn() {
        setZoomPercent(ZoomPreference.zoomedIn(from: zoomPercent))
    }

    func actualSize() {
        setZoomPercent(ZoomPreference.defaultPercent)
    }

    /// Zoom is a single app-wide setting: every window re-renders at the new
    /// percent and the value is stored right away, so a crash cannot lose it.
    private func setZoomPercent(_ percent: Int) {
        guard percent != zoomPercent else { return }
        zoomPercent = percent
        zoomStore.saveZoomPercent(percent)
        for controller in registry.all {
            controller.applyZoomPercent(percent)
        }
    }

    @discardableResult
    func openWindow(restoredFrame: NSRect? = nil) -> any DesktopWindowControlling {
        let controller = sessionFactory(restoredFrame)
        prepare(controller)
        return controller
    }

    func openWebPaneWindow(webPaneId: String) {
        guard NativeWindowProtocol.isWebPaneId(webPaneId) else { return }
        if let existing = registry.controller(forWebPaneId: webPaneId) {
            existing.show()
            return
        }
        let controller = detachedSessionFactory(webPaneId)
        prepare(controller)
    }

    func focusWebPaneWindow(webPaneId: String) {
        if let existing = registry.controller(forWebPaneId: webPaneId) {
            existing.show()
        } else {
            openWebPaneWindow(webPaneId: webPaneId)
        }
    }

    func reattachWebPaneWindow(webPaneId: String) {
        registry.controller(forWebPaneId: webPaneId)?.close()
    }

    private func prepare(_ controller: any DesktopWindowControlling) {
        controller.setWindowCommandHandler(self)
        controller.applyZoomPercent(zoomPercent)
        controller.window.delegate = self
        registry.register(controller)
        publishDetachedWebPaneIds()
        controller.show()
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
        if let controller = activeController ?? registry.lastWorkspace {
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
        controller.setWindowActive(false)
        controller.cleanUp()
        publishDetachedWebPaneIds()
        persistWindowState()
    }

    func windowDidResize(_ notification: Notification) {
        controller(from: notification)?.reapplyTerminalFrames()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        controller(from: notification)?.setWindowActive(true)
    }

    func windowDidResignKey(_ notification: Notification) {
        controller(from: notification)?.setWindowActive(false)
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
        restorationStore.saveFrames(
            registry.all.filter { $0.role == .workspace }.map { $0.window.frame }
        )
    }

    private func publishDetachedWebPaneIds() {
        let ids = registry.detachedWebPaneIds
        for controller in registry.all {
            controller.setDetachedWebPaneIds(ids)
        }
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
