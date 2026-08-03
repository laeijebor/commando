import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let store = CompanionStore()
    private var panelController: IslandPanelController?
    private var visorController: VisorTerminalController?
    private var visorHotKey: VisorGlobalHotKey?
    private var statusItem: NSStatusItem?
    private var displayMenu: NSMenu?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panelController = IslandPanelController(
            store: store,
            onQuit: { NSApplication.shared.terminate(nil) }
        )
        self.panelController = panelController
        visorController = VisorTerminalController()
        visorHotKey = VisorGlobalHotKey()
        if visorHotKey == nil {
            NSLog("Commando Island could not register the Option-F12 visor shortcut")
        }
        configureStatusItem()
        panelController.show()
        store.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        visorHotKey?.invalidate()
        visorController?.shutdown()
        store.stop()
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(
            systemSymbolName: "terminal.fill",
            accessibilityDescription: "Commando Island"
        )
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(withTitle: "Show Commando Island", action: #selector(showIsland), keyEquivalent: "i")
        menu.addItem(withTitle: "Toggle Visor Terminal", action: #selector(toggleVisor), keyEquivalent: "")
        let displayItem = NSMenuItem(title: "Move to Display", action: nil, keyEquivalent: "")
        let displayMenu = NSMenu(title: "Move to Display")
        displayMenu.delegate = self
        displayItem.submenu = displayMenu
        menu.addItem(displayItem)
        menu.addItem(withTitle: "Refresh usage", action: #selector(refreshUsage), keyEquivalent: "r")
        menu.addItem(withTitle: "Open Commando", action: #selector(openCommando), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Commando Island", action: #selector(quit), keyEquivalent: "q")
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        statusItem = item
        self.displayMenu = displayMenu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === statusItem?.menu || menu === displayMenu else { return }
        rebuildDisplayMenu()
    }

    private func rebuildDisplayMenu() {
        guard let displayMenu, let panelController else { return }
        displayMenu.removeAllItems()

        let pointerItem = NSMenuItem(
            title: "Use Pointer Location at Launch",
            action: #selector(usePointerDisplay),
            keyEquivalent: ""
        )
        pointerItem.target = self
        pointerItem.state = panelController.selectedDisplayKey == nil ? .on : .off
        displayMenu.addItem(pointerItem)
        displayMenu.addItem(.separator())

        for display in panelController.displayOptions {
            let item = NSMenuItem(
                title: display.name,
                action: #selector(moveToDisplay(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = display.key
            item.state = panelController.selectedDisplayKey == display.key ? .on : .off
            displayMenu.addItem(item)
        }
    }

    @objc private func showIsland() {
        panelController?.toggle()
    }

    @objc private func toggleVisor() {
        visorController?.toggle()
    }

    func toggleVisorFromShortcut() {
        visorController?.toggle()
    }

    @objc private func refreshUsage() {
        store.refreshUsage()
    }

    @objc private func moveToDisplay(_ sender: NSMenuItem) {
        guard let displayKey = sender.representedObject as? String else { return }
        panelController?.move(toDisplayKey: displayKey)
    }

    @objc private func usePointerDisplay() {
        panelController?.usePointerDisplay()
    }

    @objc private func openCommando() {
        store.openCommando()
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

@main
enum CommandoIslandMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
