import AppKit
import Carbon.HIToolbox
import Darwin
import SwiftTerm

struct VisorShortcut {
    static let keyCode = UInt32(kVK_F12)
    static let carbonModifiers = UInt32(optionKey)
    static let signature: OSType = 0x434D4456 // CMDV
    static let identifier: UInt32 = 1
}

struct VisorGeometry {
    static func frame(visibleFrame: CGRect) -> CGRect {
        let availableWidth = max(1, visibleFrame.width - 32)
        let availableHeight = max(1, visibleFrame.height - 24)
        let width = min(availableWidth, min(1_320, max(720, visibleFrame.width * 0.82)))
        let height = min(availableHeight, min(560, max(300, visibleFrame.height * 0.42)))

        return CGRect(
            x: visibleFrame.midX - width / 2,
            y: visibleFrame.minY + 12,
            width: width,
            height: height
        )
    }
}

struct VisorShellConfiguration {
    static let fallbackExecutable = "/bin/zsh"
    static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    static func executable(
        environment: [String: String],
        accountShell: String?
    ) -> String {
        for candidate in [environment["SHELL"], accountShell, fallbackExecutable] {
            if let candidate, candidate.hasPrefix("/") { return candidate }
        }
        return fallbackExecutable
    }

    static func processEnvironment(inherited: [String: String]) -> [String] {
        var environment = inherited
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["COMMANDO_VISOR"] = "1"
        if environment["LANG"]?.isEmpty != false { environment["LANG"] = "en_US.UTF-8" }
        if environment["PATH"]?.isEmpty != false { environment["PATH"] = fallbackPath }
        return environment
            .map { "\($0.key)=\($0.value)" }
            .sorted()
    }
}

@MainActor
final class VisorGlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?

    init?() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            visorHotKeyEventHandler,
            1,
            &eventType,
            nil,
            &eventHandlerRef
        )
        guard handlerStatus == noErr else { return nil }

        let identifier = EventHotKeyID(
            signature: VisorShortcut.signature,
            id: VisorShortcut.identifier
        )
        let hotKeyStatus = RegisterEventHotKey(
            VisorShortcut.keyCode,
            VisorShortcut.carbonModifiers,
            identifier,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        guard hotKeyStatus == noErr else {
            if let eventHandlerRef { RemoveEventHandler(eventHandlerRef) }
            eventHandlerRef = nil
            return nil
        }
    }

    func invalidate() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let eventHandlerRef { RemoveEventHandler(eventHandlerRef) }
        hotKeyRef = nil
        eventHandlerRef = nil
    }
}

private let visorHotKeyEventHandler: EventHandlerUPP = { _, event, _ in
    guard let event else { return OSStatus(eventNotHandledErr) }
    var identifier = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &identifier
    )
    guard status == noErr,
          identifier.signature == VisorShortcut.signature,
          identifier.id == VisorShortcut.identifier else {
        return OSStatus(eventNotHandledErr)
    }

    MainActor.assumeIsolated {
        (NSApplication.shared.delegate as? AppDelegate)?.toggleVisorFromShortcut()
    }
    return noErr
}

private final class VisorPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class VisorContentView: NSView {
    let terminalView: LocalProcessTerminalView

    init(terminalView: LocalProcessTerminalView) {
        self.terminalView = terminalView
        super.init(frame: .zero)

        wantsLayer = true
        layer?.backgroundColor = NSColor(
            calibratedRed: 0.055,
            green: 0.047,
            blue: 0.075,
            alpha: 0.98
        ).cgColor
        layer?.borderColor = NSColor(
            calibratedRed: 0.61,
            green: 0.42,
            blue: 1,
            alpha: 0.7
        ).cgColor
        layer?.borderWidth = 1
        layer?.cornerRadius = 16
        layer?.masksToBounds = true

        let header = NSView()
        header.wantsLayer = true
        header.layer?.backgroundColor = NSColor(
            calibratedRed: 0.105,
            green: 0.086,
            blue: 0.145,
            alpha: 1
        ).cgColor
        header.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "COMMANDO // VISOR")
        title.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
        title.textColor = NSColor(
            calibratedRed: 0.76,
            green: 0.66,
            blue: 1,
            alpha: 1
        )
        title.translatesAutoresizingMaskIntoConstraints = false

        let hint = NSTextField(labelWithString: "LOCAL SHELL   FN + OPTION + F12")
        hint.font = NSFont.monospacedSystemFont(ofSize: 9, weight: .medium)
        hint.textColor = NSColor.white.withAlphaComponent(0.44)
        hint.alignment = .right
        hint.translatesAutoresizingMaskIntoConstraints = false

        terminalView.translatesAutoresizingMaskIntoConstraints = false
        terminalView.setAccessibilityLabel("Commando visor terminal")

        addSubview(header)
        addSubview(terminalView)
        header.addSubview(title)
        header.addSubview(hint)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor),
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 34),

            title.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            title.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            hint.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 12),
            hint.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            hint.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            terminalView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
final class VisorTerminalController: NSObject,
    @preconcurrency LocalProcessTerminalViewDelegate
{
    private let panel: VisorPanel
    private let terminalView: LocalProcessTerminalView
    private var previousApplication: NSRunningApplication?
    private var screenObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?
    private var localMouseMonitor: Any?
    private var globalMouseMonitor: Any?
    private var hasLaunchedShell = false
    private var isShuttingDown = false

    override init() {
        terminalView = LocalProcessTerminalView(frame: .zero)
        panel = VisorPanel(
            contentRect: CGRect(origin: .zero, size: CGSize(width: 1_000, height: 440)),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        super.init()

        configureTerminal()
        panel.level = .floating
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
        panel.contentView = VisorContentView(terminalView: terminalView)

        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.panel.isVisible else { return }
                self.placePanel()
            }
        }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApplication.shared,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hide(restoringPreviousApplication: false)
            }
        }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self,
                      self.panel.isVisible,
                      event.window !== self.panel else { return }
                self.hide(restoringPreviousApplication: false)
            }
            return event
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hide(restoringPreviousApplication: false)
            }
        }
    }

    func toggle() {
        if panel.isVisible { hide(restoringPreviousApplication: true) }
        else { show() }
    }

    func show() {
        guard !panel.isVisible else { return }
        previousApplication = frontmostExternalApplication()
        placePanel()
        startShellIfNeeded()
        NSApplication.shared.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.makeFirstResponder(terminalView)
    }

    func hide(restoringPreviousApplication: Bool) {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        if restoringPreviousApplication {
            previousApplication?.activate(options: [])
        }
        previousApplication = nil
    }

    func shutdown() {
        isShuttingDown = true
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        if let activationObserver { NotificationCenter.default.removeObserver(activationObserver) }
        if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        screenObserver = nil
        activationObserver = nil
        localMouseMonitor = nil
        globalMouseMonitor = nil
        if terminalView.process.running { terminalView.terminate() }
    }

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        guard !isShuttingDown else { return }
        hide(restoringPreviousApplication: true)
    }

    private func configureTerminal() {
        terminalView.processDelegate = self
        terminalView.font = NSFont(name: "JetBrains Mono", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminalView.nativeBackgroundColor = NSColor(
            calibratedRed: 0.055,
            green: 0.047,
            blue: 0.075,
            alpha: 1
        )
        terminalView.nativeForegroundColor = NSColor(
            calibratedRed: 0.88,
            green: 0.84,
            blue: 0.96,
            alpha: 1
        )
        terminalView.caretColor = NSColor(
            calibratedRed: 0.61,
            green: 0.42,
            blue: 1,
            alpha: 1
        )
        terminalView.selectedTextBackgroundColor = NSColor(
            calibratedRed: 0.42,
            green: 0.30,
            blue: 0.66,
            alpha: 0.72
        )
        terminalView.caretViewTracksFocus = true
        terminalView.scrollerStyle = .overlay
    }

    private func startShellIfNeeded() {
        guard !terminalView.process.running else { return }
        if hasLaunchedShell { terminalView.getTerminal().resetToInitialState() }
        hasLaunchedShell = true

        let inherited = ProcessInfo.processInfo.environment
        let shell = VisorShellConfiguration.executable(
            environment: inherited,
            accountShell: accountShell()
        )
        terminalView.startProcess(
            executable: shell,
            environment: VisorShellConfiguration.processEnvironment(inherited: inherited),
            execName: "-\(URL(fileURLWithPath: shell).lastPathComponent)",
            currentDirectory: FileManager.default.homeDirectoryForCurrentUser.path
        )
    }

    private func accountShell() -> String? {
        guard let passwordEntry = getpwuid(getuid()),
              let shell = passwordEntry.pointee.pw_shell else { return nil }
        return String(cString: shell)
    }

    private func placePanel() {
        panel.setFrame(VisorGeometry.frame(visibleFrame: targetScreen().visibleFrame), display: true)
    }

    private func targetScreen() -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? panel.screen
            ?? NSScreen.main
            ?? NSScreen.screens[0]
    }

    private func frontmostExternalApplication() -> NSRunningApplication? {
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            return nil
        }
        return application
    }
}
