import AppKit

extension Notification.Name {
    static let commandoFirstResponderDidChange = Notification.Name(
        "CommandoDesktopFirstResponderDidChange"
    )
}

@MainActor
final class DesktopWindow: NSWindow {
    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let previous = firstResponder
        let accepted = super.makeFirstResponder(responder)
        if accepted, previous !== firstResponder {
            NotificationCenter.default.post(name: .commandoFirstResponderDidChange, object: self)
        }
        return accepted
    }
}

@MainActor
enum DesktopMainMenu {
    static func make() -> NSMenu {
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

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        return mainMenu
    }
}

@MainActor
final class DesktopAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webHost: DesktopWebHost?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = DesktopMainMenu.make()

        let webHost = DesktopWebHost()
        let window = DesktopWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Commando"
        window.minSize = NSSize(width: 760, height: 540)
        window.isReleasedWhenClosed = false
        window.contentView = webHost.rootView
        window.delegate = self
        window.center()

        self.webHost = webHost
        self.window = window
        window.makeKeyAndOrderFront(nil)
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        cleanUp()
    }

    func windowWillClose(_ notification: Notification) {
        cleanUp()
    }

    func windowDidResize(_ notification: Notification) {
        webHost?.reapplyTerminalFrames()
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        webHost?.reapplyTerminalFrames()
    }

    private func cleanUp() {
        webHost?.cleanUp()
        webHost = nil
        window?.delegate = nil
        window = nil
    }

}

@main
@MainActor
struct CommandoDesktopApp {
    static func main() {
        let application = NSApplication.shared
        let delegate = DesktopAppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}
