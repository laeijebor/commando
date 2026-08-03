import AppKit

enum DesktopConnectionState: Equatable, Sendable {
    case connecting
    case retrying
}

@MainActor
final class ConnectionStatusView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let progress = NSProgressIndicator()

    private(set) var state: DesktopConnectionState?
    var statusText: String { label.stringValue }

    override var isOpaque: Bool { false }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func show(_ state: DesktopConnectionState, origin: WebOrigin) {
        self.state = state
        switch state {
        case .connecting:
            label.stringValue = "Connecting to external Commando service at \(origin.displayName)..."
        case .retrying:
            label.stringValue = "External Commando service unavailable at \(origin.displayName). Retrying..."
        }
        isHidden = false
        progress.startAnimation(nil)
    }

    func hide() {
        state = nil
        isHidden = true
        progress.stopAnimation(nil)
    }

    private func configure() {
        wantsLayer = true
        isHidden = true

        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.blendingMode = .withinWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 8
        background.translatesAutoresizingMaskIntoConstraints = false

        progress.style = .spinning
        progress.controlSize = .small
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle

        let stack = NSStackView(views: [progress, label])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(background)
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            background.centerXAnchor.constraint(equalTo: centerXAnchor),
            background.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32),
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            stack.topAnchor.constraint(equalTo: background.topAnchor),
            stack.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])
    }
}
