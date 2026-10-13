import Foundation

struct TerminalInputCut: Equatable {
    let text: String
    let clear: String

    static func extract(rows: [String], cols: Int, cursorRow: Int, cursorCol: Int, wrapped: [Bool]? = nil) -> Self? {
        guard rows.indices.contains(cursorRow), !isRule(rows[cursorRow]) else { return nil }
        for start in rows.indices.reversed() where start > 0 {
            guard rows[start].range(of: "^(?:│ )?[❯>][ \u{00a0}]", options: .regularExpression) != nil,
                  isRule(rows[start - 1]),
                  let end = rows.indices.first(where: { $0 > start && isRule(rows[$0]) }),
                  start <= cursorRow, cursorRow < end
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
        func continues(_ row: String) -> Bool {
            let cells = Array(row.unicodeScalars)
            return cells.indices.contains(cols - 1) && cells[cols - 1] != " "
        }
        var firstRow = cursorRow
        var lastRow = cursorRow
        func isWrapped(_ row: Int) -> Bool? {
            guard let wrapped, wrapped.indices.contains(row) else { return nil }
            return wrapped[row]
        }
        while firstRow > 0 && (isWrapped(firstRow) ?? continues(rows[firstRow - 1])) { firstRow -= 1 }
        while lastRow + 1 < rows.count && (isWrapped(lastRow + 1) ?? continues(rows[lastRow])) { lastRow += 1 }
        var text = rows[firstRow...lastRow].joined()
        let cursorOffset = (cursorRow - firstRow) * cols + cursorCol
        let prompt = text.range(of: "^.*?(?:[$#❯>]|(?<![0-9])%)[ \u{00a0}]", options: .regularExpression)
        if let prompt,
           text[prompt].unicodeScalars.count <= cursorOffset {
            text = String(text[prompt.upperBound...])
                .replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        } else {
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text.isEmpty ? nil : Self(text: text, clear: prompt == nil ? "" : "\u{05}\u{15}")
    }

    private static func isRule(_ row: String) -> Bool {
        let trimmed = row.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.filter { $0 == "─" }.count >= 10
            && trimmed.allSatisfy { "─━╭╮╰╯│".contains($0) }
    }
}
