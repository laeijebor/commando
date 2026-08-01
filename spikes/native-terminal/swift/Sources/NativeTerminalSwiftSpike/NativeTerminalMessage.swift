import Foundation

struct TerminalFramePayload: Decodable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let visible: Bool
    let scale: Double
}

enum NativeTerminalMessage: Decodable, Equatable, Sendable {
    case frame(TerminalFramePayload)
    case focus

    private enum CodingKeys: String, CodingKey {
        case kind
        case x
        case y
        case width
        case height
        case visible
        case scale
    }

    private enum Kind: String, Decodable {
        case frame
        case focus
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        switch try container.decode(Kind.self, forKey: .kind) {
        case .focus:
            self = .focus
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
