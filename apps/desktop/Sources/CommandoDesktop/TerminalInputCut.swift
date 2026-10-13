import Foundation

struct TerminalInputCut: Equatable {
    let text: String
    let clear: String

    static func extract(rows: [String], cols: Int, cursorRow: Int, cursorCol: Int) -> Self? {
        for start in rows.indices.reversed() where start > 0 {
            guard rows[start].range(of: "^(?:│ )?[❯>][ \u{00a0}]", options: .regularExpression) != nil,
                  isRule(rows[start - 1]),
                  let end = rows.indices.first(where: { $0 > start && isRule(rows[$0]) })
            else { continue }
            let contentWidth = cols - 2 - (rows[start].hasPrefix("│ ") ? 4 : 0)
            let lines = rows[start..<end].enumerated().map { index, row in
                var content = row.replacingOccurrences(of: "^│ ?", with: "", options: .regularExpression)
                    .replacingOccurrences(of: " *│ *$", with: "", options: .regularExpression)
                content = content.replacingOccurrences(
                    of: index == 0 ? "^[❯>][ \u{00a0}]" : "^  ", with: "", options: .regularExpression
                )
                return content.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
            }
            var text = lines[0]
            for index in lines.indices.dropFirst() {
                let prev = lines[index - 1]
                let next = lines[index]
                let firstWord = next.prefix(while: { !$0.isWhitespace })
                let separator = prev.unicodeScalars.count + 1 + firstWord.unicodeScalars.count > contentWidth
                    ? " " : prev.unicodeScalars.count >= contentWidth ? "" : "\n"
                text += separator + next
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let repeats = 2 * lines.count + 1
            return Self(text: text, clear: String(repeating: "\u{0b}", count: repeats)
                + String(repeating: "\u{15}", count: repeats))
        }
        guard rows.indices.contains(cursorRow) else { return nil }
        var text = rows[cursorRow].replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        if let prompt = text.range(of: "^.*?[$%#❯>][ \u{00a0}]", options: .regularExpression),
           text[prompt].unicodeScalars.count <= cursorCol {
            text = String(text[prompt.upperBound...])
        }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : Self(text: text, clear: "\u{05}\u{15}")
    }

    private static func isRule(_ row: String) -> Bool {
        let trimmed = row.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.filter { $0 == "─" }.count >= 10
            && trimmed.allSatisfy { "─━╭╮╰╯│".contains($0) }
    }
}
