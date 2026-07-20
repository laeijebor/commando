import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = CompanionStore()
    private var panelController: IslandPanelController?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panelController = IslandPanelController(store: store)
        self.panelController = panelController
        configureStatusItem()
        panelController.show()
        store.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.stop()
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(
            systemSymbolName: "terminal.fill",
            accessibilityDescription: "Commando Island"
        )
        let menu = NSMenu()
        menu.addItem(withTitle: "Show Commando Island", action: #selector(showIsland), keyEquivalent: "i")
        menu.addItem(withTitle: "Refresh usage", action: #selector(refreshUsage), keyEquivalent: "r")
        menu.addItem(withTitle: "Open Commando", action: #selector(openCommando), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Commando Island", action: #selector(quit), keyEquivalent: "q")
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        statusItem = item
    }

    @objc private func showIsland() {
        panelController?.toggle()
    }

    @objc private func refreshUsage() {
        store.refreshUsage()
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
