import CoreFoundation
import Foundation

enum NativeTerminalProtocol {
    static let name = "commando.native-terminal"
    static let version = 1
    static let handlerName = "commandoNativeTerminal"
    static let maxPanes = 64
    static let maxSafeInteger = 9_007_199_254_740_991
    static let maxResetBytes = 5 * 1_024 * 1_024
    static let maxDataBytes = 64 * 1_024
    static let maxInputBytes = 8 * 1_024
    static let maxVisibleRegions = 64
    static let minCols = 2
    static let maxCols = 500
    static let minRows = 1
    static let maxRows = 200

    static let requiredCapabilities = [
        "terminal.multiPane.v1",
        "terminal.binaryInput.v1",
        "terminal.cssPixelGeometry.v1",
        "terminal.attachmentLifecycle.v1",
        "terminal.visibleRegions.v1",
        "terminal.coreGraphics",
    ]
}

struct ProtocolValidationError: Error, Equatable, CustomStringConvertible {
    let code: String
    let message: String

    var description: String { message }
}

struct PaneIdentity: Equatable, Hashable, Sendable {
    let paneId: String
    let attachmentId: String
}

struct BridgeConnectPayload: Equatable, Sendable {
    let supportedVersions: [Int]
}

struct PaneAttachPayload: Equatable, Sendable {
    let identity: PaneIdentity
    let ariaLabel: String
}

struct PaneFramePayload: Equatable, Sendable {
    let identity: PaneIdentity
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let scale: Double
    let visible: Bool
    let visibleRegions: [PaneVisibleRegion]
    let resizeOwner: Bool
    let order: Int
}

struct PaneVisibleRegion: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct PaneResetPayload: Equatable, Sendable {
    let identity: PaneIdentity
    let data: Data
    let cols: Int
    let rows: Int
    let revision: Int
}

struct PaneDataPayload: Equatable, Sendable {
    let identity: PaneIdentity
    let data: Data
    let revision: Int
}

enum NativeTerminalCommand: Equatable, Sendable {
    case connect(BridgeConnectPayload)
    case attach(PaneAttachPayload)
    case frame(PaneFramePayload)
    case focus(PaneIdentity)
    case reset(PaneResetPayload)
    case data(PaneDataPayload)
    case detach(PaneIdentity)

    var type: String {
        switch self {
        case .connect: "bridge.connect"
        case .attach: "pane.attach"
        case .frame: "pane.frame"
        case .focus: "pane.focus"
        case .reset: "pane.reset"
        case .data: "pane.data"
        case .detach: "pane.detach"
        }
    }
}

struct NativeTerminalEnvelope: Equatable, Sendable {
    let pageId: String
    let sequence: Int
    let command: NativeTerminalCommand

    static func decode(jsonObject: Any) throws -> NativeTerminalEnvelope {
        let envelope = try StrictObject(jsonObject, context: "message")
        try envelope.require(keys: ["protocol", "version", "pageId", "sequence", "type", "payload"])

        guard try envelope.string("protocol") == NativeTerminalProtocol.name else {
            throw ProtocolValidationError(
                code: "invalid_protocol",
                message: "Unsupported native terminal protocol."
            )
        }
        guard try envelope.integer("version") == NativeTerminalProtocol.version else {
            throw ProtocolValidationError(
                code: "unsupported_version",
                message: "Unsupported native terminal protocol version."
            )
        }

        let pageId = try validateGenericIdentifier(try envelope.string("pageId"), field: "pageId")
        let sequence = try envelope.safeInteger("sequence")
        let type = try envelope.string("type")
        let payload = try envelope.object("payload")
        let command = try decodeCommand(type: type, payload: payload)

        return NativeTerminalEnvelope(pageId: pageId, sequence: sequence, command: command)
    }

    static func recoverablePageId(from jsonObject: Any) -> String? {
        guard let dictionary = jsonObject as? [String: Any],
              let value = dictionary["pageId"] as? String,
              let validated = try? validateGenericIdentifier(value, field: "pageId")
        else {
            return nil
        }
        return validated
    }

    private static func decodeCommand(
        type: String,
        payload: StrictObject
    ) throws -> NativeTerminalCommand {
        switch type {
        case "bridge.connect":
            try payload.require(keys: ["supportedVersions"])
            let versions = try payload.integerArray("supportedVersions", maximumCount: 16)
            guard !versions.isEmpty else {
                throw ProtocolValidationError(
                    code: "invalid_payload",
                    message: "supportedVersions must not be empty."
                )
            }
            return .connect(.init(supportedVersions: versions))
        case "pane.attach":
            try payload.require(keys: ["paneId", "attachmentId", "ariaLabel"])
            let identity = try decodeIdentity(payload)
            let ariaLabel = try validateAriaLabel(try payload.string("ariaLabel"))
            return .attach(.init(identity: identity, ariaLabel: ariaLabel))
        case "pane.frame":
            try payload.require(keys: [
                "paneId", "attachmentId", "x", "y", "width", "height", "scale",
                "visible", "visibleRegions", "resizeOwner", "order",
            ])
            let identity = try decodeIdentity(payload)
            let x = try payload.finiteDouble("x")
            let y = try payload.finiteDouble("y")
            let width = try payload.finiteDouble("width")
            let height = try payload.finiteDouble("height")
            let scale = try payload.finiteDouble("scale")
            guard width >= 0, height >= 0, scale > 0 else {
                throw ProtocolValidationError(
                    code: "invalid_geometry",
                    message: "Frame dimensions must be nonnegative and scale must be positive."
                )
            }
            let visibleRegions = try payload.objectArray(
                "visibleRegions",
                maximumCount: NativeTerminalProtocol.maxVisibleRegions
            ).map { region in
                try region.require(keys: ["x", "y", "width", "height"])
                let width = try region.finiteDouble("width")
                let height = try region.finiteDouble("height")
                guard width > 0, height > 0 else {
                    throw ProtocolValidationError(
                        code: "invalid_geometry",
                        message: "Visible region dimensions must be positive."
                    )
                }
                return PaneVisibleRegion(
                    x: try region.finiteDouble("x"),
                    y: try region.finiteDouble("y"),
                    width: width,
                    height: height
                )
            }
            return .frame(.init(
                identity: identity,
                x: x,
                y: y,
                width: width,
                height: height,
                scale: scale,
                visible: try payload.boolean("visible"),
                visibleRegions: visibleRegions,
                resizeOwner: try payload.boolean("resizeOwner"),
                order: try payload.javascriptSafeInteger("order")
            ))
        case "pane.focus":
            try payload.require(keys: ["paneId", "attachmentId"])
            return .focus(try decodeIdentity(payload))
        case "pane.reset":
            try payload.require(keys: [
                "paneId", "attachmentId", "data", "cols", "rows", "revision",
            ])
            let cols = try payload.integer("cols")
            let rows = try payload.integer("rows")
            guard (NativeTerminalProtocol.minCols...NativeTerminalProtocol.maxCols).contains(cols),
                  (NativeTerminalProtocol.minRows...NativeTerminalProtocol.maxRows).contains(rows)
            else {
                throw ProtocolValidationError(
                    code: "invalid_grid",
                    message: "Terminal grid is outside supported bounds."
                )
            }
            return .reset(.init(
                identity: try decodeIdentity(payload),
                data: try payload.canonicalBase64("data", maximumBytes: NativeTerminalProtocol.maxResetBytes),
                cols: cols,
                rows: rows,
                revision: try payload.safeInteger("revision")
            ))
        case "pane.data":
            try payload.require(keys: ["paneId", "attachmentId", "data", "revision"])
            return .data(.init(
                identity: try decodeIdentity(payload),
                data: try payload.canonicalBase64("data", maximumBytes: NativeTerminalProtocol.maxDataBytes),
                revision: try payload.safeInteger("revision")
            ))
        case "pane.detach":
            try payload.require(keys: ["paneId", "attachmentId"])
            return .detach(try decodeIdentity(payload))
        default:
            throw ProtocolValidationError(
                code: "unsupported_command",
                message: "Unsupported native terminal command."
            )
        }
    }

    private static func decodeIdentity(_ payload: StrictObject) throws -> PaneIdentity {
        PaneIdentity(
            paneId: try validatePaneId(try payload.string("paneId")),
            attachmentId: try validateGenericIdentifier(
                try payload.string("attachmentId"),
                field: "attachmentId"
            )
        )
    }

    private static func validatePaneId(_ value: String) throws -> String {
        let bytes = Array(value.utf8)
        guard (2...32).contains(bytes.count),
              bytes.first == Character("%").asciiValue,
              bytes.dropFirst().allSatisfy({ (48...57).contains($0) })
        else {
            throw ProtocolValidationError(
                code: "invalid_id",
                message: "paneId must be a tmux pane identifier."
            )
        }
        return value
    }

    private static func validateGenericIdentifier(_ value: String, field: String) throws -> String {
        let bytes = Array(value.utf8)
        guard (1...256).contains(bytes.count), bytes.allSatisfy({ (0x21...0x7e).contains($0) }) else {
            throw ProtocolValidationError(
                code: "invalid_id",
                message: "\(field) must be a printable ASCII identifier."
            )
        }
        return value
    }

    private static func validateAriaLabel(_ value: String) throws -> String {
        guard (1...512).contains(value.utf8.count),
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else {
            throw ProtocolValidationError(
                code: "invalid_payload",
                message: "ariaLabel must be a nonempty label without control characters."
            )
        }
        return value
    }
}

private struct StrictObject {
    private let storage: [String: Any]
    private let context: String

    init(_ value: Any, context: String) throws {
        guard let storage = value as? [String: Any] else {
            throw ProtocolValidationError(
                code: "invalid_payload",
                message: "\(context) must be an object."
            )
        }
        self.storage = storage
        self.context = context
    }

    func require(keys: Set<String>) throws {
        guard Set(storage.keys) == keys else {
            throw ProtocolValidationError(
                code: "invalid_payload",
                message: "\(context) has missing or unexpected fields."
            )
        }
    }

    func string(_ key: String) throws -> String {
        guard let value = storage[key] as? String else {
            throw fieldError(key, expected: "a string")
        }
        return value
    }

    func boolean(_ key: String) throws -> Bool {
        guard let number = storage[key] as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else {
            throw fieldError(key, expected: "a boolean")
        }
        return number.boolValue
    }

    func integer(_ key: String) throws -> Int {
        let value = try numericValue(key)
        guard value.rounded(.towardZero) == value,
              value >= Double(Int.min), value <= Double(Int.max)
        else {
            throw fieldError(key, expected: "an integer")
        }
        return Int(value)
    }

    func safeInteger(_ key: String) throws -> Int {
        let value = try numericValue(key)
        guard value.rounded(.towardZero) == value,
              value >= 0,
              value <= Double(NativeTerminalProtocol.maxSafeInteger)
        else {
            throw fieldError(key, expected: "a nonnegative JavaScript-safe integer")
        }
        return Int(value)
    }

    func javascriptSafeInteger(_ key: String) throws -> Int {
        let value = try numericValue(key)
        guard value.rounded(.towardZero) == value,
              abs(value) <= Double(NativeTerminalProtocol.maxSafeInteger)
        else {
            throw fieldError(key, expected: "a JavaScript-safe integer")
        }
        return Int(value)
    }

    func finiteDouble(_ key: String) throws -> Double {
        try numericValue(key)
    }

    func object(_ key: String) throws -> StrictObject {
        guard let value = storage[key] else {
            throw fieldError(key, expected: "an object")
        }
        return try StrictObject(value, context: key)
    }

    func integerArray(_ key: String, maximumCount: Int) throws -> [Int] {
        guard let values = storage[key] as? [Any], values.count <= maximumCount else {
            throw fieldError(key, expected: "a bounded integer array")
        }
        return try values.map { value in
            let item = try StrictObject(["value": value], context: key)
            return try item.safeInteger("value")
        }
    }

    func objectArray(_ key: String, maximumCount: Int) throws -> [StrictObject] {
        guard let values = storage[key] as? [Any], values.count <= maximumCount else {
            throw fieldError(key, expected: "a bounded object array")
        }
        return try values.map { try StrictObject($0, context: "\(context).\(key)") }
    }

    func canonicalBase64(_ key: String, maximumBytes: Int) throws -> Data {
        let encoded = try string(key)
        let maximumEncodedLength = ((maximumBytes + 2) / 3) * 4
        guard encoded.utf8.count <= maximumEncodedLength,
              let decoded = Data(base64Encoded: encoded),
              decoded.count <= maximumBytes,
              decoded.base64EncodedString() == encoded
        else {
            throw ProtocolValidationError(
                code: "invalid_data",
                message: "\(key) must be canonical base64 within the command byte limit."
            )
        }
        return decoded
    }

    private func numericValue(_ key: String) throws -> Double {
        guard let number = storage[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            throw fieldError(key, expected: "a number")
        }
        let value = number.doubleValue
        guard value.isFinite else {
            throw fieldError(key, expected: "a finite number")
        }
        return value
    }

    private func fieldError(_ key: String, expected: String) -> ProtocolValidationError {
        ProtocolValidationError(
            code: "invalid_payload",
            message: "\(context).\(key) must be \(expected)."
        )
    }
}

enum BridgeSequenceDecision: Equatable, Sendable {
    case connected(replacedPage: Bool)
    case accepted
    case rejected(code: String)
}

struct BridgeSequenceGate: Sendable {
    private(set) var pageId: String?
    private(set) var lastSequence: Int?

    mutating func accept(_ envelope: NativeTerminalEnvelope) -> BridgeSequenceDecision {
        if case .connect = envelope.command {
            if envelope.pageId == pageId,
               let lastSequence,
               envelope.sequence <= lastSequence {
                return .rejected(code: "stale_sequence")
            }
            let replacedPage = pageId != nil
            pageId = envelope.pageId
            lastSequence = envelope.sequence
            return .connected(replacedPage: replacedPage)
        }

        guard envelope.pageId == pageId else {
            return .rejected(code: pageId == nil ? "bridge_not_connected" : "stale_page")
        }
        guard let lastSequence, envelope.sequence > lastSequence else {
            return .rejected(code: "stale_sequence")
        }
        self.lastSequence = envelope.sequence
        return .accepted
    }

    mutating func reset() {
        pageId = nil
        lastSequence = nil
    }
}

struct TerminalDataOrderGate: Equatable, Sendable {
    private(set) var revision: Int?

    mutating func acceptReset(revision: Int) -> Bool {
        self.revision = revision
        return true
    }

    mutating func acceptData(revision: Int) -> Bool {
        guard let current = self.revision, revision > current else { return false }
        self.revision = revision
        return true
    }
}
