import Foundation

struct TerminalFramePayload: Decodable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let visible: Bool
    let scale: Double
}

struct TerminalResetPayload: Equatable, Sendable {
    let paneId: String
    let data: Data
    let cols: Int
    let rows: Int
    let revision: Int
}

struct TerminalDataPayload: Equatable, Sendable {
    let paneId: String
    let data: Data
    let revision: Int
}

enum NativeTerminalMessage: Decodable, Equatable, Sendable {
    case frame(TerminalFramePayload)
    case focus
    case reset(TerminalResetPayload)
    case data(TerminalDataPayload)

    static let minCols = 2
    static let maxCols = 500
    static let minRows = 1
    static let maxRows = 200
    static let maxSafeRevision = 9_007_199_254_740_991

    private enum CodingKeys: String, CodingKey {
        case kind
        case x
        case y
        case width
        case height
        case visible
        case scale
        case paneId
        case data
        case cols
        case rows
        case revision
    }

    private enum Kind: String, Decodable {
        case frame
        case focus
        case reset
        case data
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        switch try container.decode(Kind.self, forKey: .kind) {
        case .focus:
            self = .focus
        case .reset:
            let paneId = try Self.decodePaneId(from: container)
            let revision = try Self.decodeRevision(from: container)
            let cols = try container.decode(Int.self, forKey: .cols)
            let rows = try container.decode(Int.self, forKey: .rows)

            guard Self.minCols...Self.maxCols ~= cols,
                  Self.minRows...Self.maxRows ~= rows
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .cols,
                    in: container,
                    debugDescription: "Terminal grid must be within supported bounds."
                )
            }

            self = .reset(
                TerminalResetPayload(
                    paneId: paneId,
                    data: try Self.decodeBase64Data(from: container),
                    cols: cols,
                    rows: rows,
                    revision: revision
                )
            )
        case .data:
            self = .data(
                TerminalDataPayload(
                    paneId: try Self.decodePaneId(from: container),
                    data: try Self.decodeBase64Data(from: container),
                    revision: try Self.decodeRevision(from: container)
                )
            )
        case .frame:
            let frame = TerminalFramePayload(
                x: try container.decode(Double.self, forKey: .x),
                y: try container.decode(Double.self, forKey: .y),
                width: try container.decode(Double.self, forKey: .width),
                height: try container.decode(Double.self, forKey: .height),
                visible: try container.decode(Bool.self, forKey: .visible),
                scale: try container.decode(Double.self, forKey: .scale)
            )

            guard [frame.x, frame.y, frame.width, frame.height, frame.scale].allSatisfy(\.isFinite),
                  frame.width >= 0,
                  frame.height >= 0,
                  frame.scale > 0
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .scale,
                    in: container,
                    debugDescription: "Frame coordinates and scale must be finite, with nonnegative dimensions and a positive scale."
                )
            }

            self = .frame(frame)
        }
    }

    private static func decodePaneId(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> String {
        let paneId = try container.decode(String.self, forKey: .paneId)
        let bytes = paneId.utf8

        guard bytes.count > 1,
              bytes.first == Character("%").asciiValue,
              bytes.dropFirst().allSatisfy({ (48...57).contains($0) })
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .paneId,
                in: container,
                debugDescription: "Pane ID must be a tmux pane identifier."
            )
        }

        return paneId
    }

    private static func decodeRevision(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> Int {
        let revision = try container.decode(Int.self, forKey: .revision)
        guard (0...maxSafeRevision).contains(revision) else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: container,
                debugDescription: "Revision must be a nonnegative JavaScript-safe integer."
            )
        }
        return revision
    }

    private static func decodeBase64Data(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> Data {
        let encoded = try container.decode(String.self, forKey: .data)
        guard let data = Data(base64Encoded: encoded),
              data.base64EncodedString() == encoded
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .data,
                in: container,
                debugDescription: "Terminal data must be canonical base64."
            )
        }
        return data
    }

    static func decode(jsonObject: Any) throws -> NativeTerminalMessage {
        guard JSONSerialization.isValidJSONObject(jsonObject) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "Script message body is not a JSON object.")
            )
        }

        let data = try JSONSerialization.data(withJSONObject: jsonObject)
        return try JSONDecoder().decode(NativeTerminalMessage.self, from: data)
    }
}

struct NativeTerminalOrderGate: Sendable {
    private(set) var paneId: String?
    private(set) var revision: Int?

    mutating func accept(reset: TerminalResetPayload) -> Bool {
        paneId = reset.paneId
        revision = reset.revision
        return true
    }

    mutating func accept(data: TerminalDataPayload) -> Bool {
        guard data.paneId == paneId,
              let revision,
              data.revision > revision
        else {
            return false
        }

        self.revision = data.revision
        return true
    }
}

struct TerminalPlacement: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let isHidden: Bool
}

enum TerminalGeometry {
    static func placement(
        for frame: TerminalFramePayload,
        viewportWidth: Double,
        viewportHeight: Double,
        backingScale: Double
    ) -> TerminalPlacement {
        guard frame.visible,
              viewportWidth > 0,
              viewportHeight > 0,
              backingScale > 0
        else {
            return .init(x: 0, y: 0, width: 0, height: 0, isHidden: true)
        }

        // CSS coordinates are logical pixels. Converting through both scales keeps
        // normal Retina rendering at one AppKit point per CSS pixel and respects zoom.
        let pointsPerCSSPixel = frame.scale / backingScale
        let cssLeft = frame.x * pointsPerCSSPixel
        let cssTop = frame.y * pointsPerCSSPixel
        let cssRight = (frame.x + frame.width) * pointsPerCSSPixel
        let cssBottom = (frame.y + frame.height) * pointsPerCSSPixel

        let left = min(viewportWidth, max(0, cssLeft))
        let top = min(viewportHeight, max(0, cssTop))
        let right = min(viewportWidth, max(0, cssRight))
        let bottom = min(viewportHeight, max(0, cssBottom))
        let width = max(0, right - left)
        let height = max(0, bottom - top)

        guard width > 0, height > 0 else {
            return .init(x: left, y: viewportHeight - bottom, width: 0, height: 0, isHidden: true)
        }

        return .init(
            x: left,
            y: viewportHeight - bottom,
            width: width,
            height: height,
            isHidden: false
        )
    }
}
