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
    static func make(zoomTarget: AnyObject? = nil) -> NSMenu {
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

        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: "View")
        viewMenu.autoenablesItems = false
        let zoomOutItem = viewMenu.addItem(
            withTitle: "Zoom Out",
            action: #selector(DesktopWebHost.zoomOut(_:)),
            keyEquivalent: "-"
        )
        zoomOutItem.target = zoomTarget
        zoomOutItem.keyEquivalentModifierMask = .command
        let zoomInItem = viewMenu.addItem(
            withTitle: "Zoom In",
            action: #selector(DesktopWebHost.zoomIn(_:)),
            keyEquivalent: "="
        )
        zoomInItem.target = zoomTarget
        zoomInItem.keyEquivalentModifierMask = .command
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)
        return mainMenu
    }
}

@MainActor
final class DesktopAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webHost: DesktopWebHost?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let webHost = DesktopWebHost()
        NSApp.mainMenu = DesktopMainMenu.make(zoomTarget: webHost)
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
        window.zoomShortcutWasPressed = { [weak webHost] key in
            if key == "-" {
                webHost?.zoomOut(nil)
            } else {
                webHost?.zoomIn(nil)
            }
        }
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
