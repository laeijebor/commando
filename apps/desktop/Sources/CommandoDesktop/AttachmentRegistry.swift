import Foundation

struct AttachmentRecord<Value> {
    let identity: PaneIdentity
    let value: Value
}

struct AttachmentRegistry<Value> {
    let maximumCount: Int
    private(set) var records: [String: AttachmentRecord<Value>] = [:]

    var count: Int { records.count }

    func record(for identity: PaneIdentity) -> AttachmentRecord<Value>? {
        guard let record = records[identity.paneId], record.identity == identity else { return nil }
        return record
    }

    func record(forPaneId paneId: String) -> AttachmentRecord<Value>? {
        records[paneId]
    }

    func canInsert(_ identity: PaneIdentity) -> Bool {
        records[identity.paneId] != nil || records.count < maximumCount
    }

    @discardableResult
    mutating func insert(_ value: Value, for identity: PaneIdentity) -> AttachmentRecord<Value>? {
        precondition(canInsert(identity))
        return records.updateValue(.init(identity: identity, value: value), forKey: identity.paneId)
    }

    mutating func remove(_ identity: PaneIdentity) -> AttachmentRecord<Value>? {
        guard record(for: identity) != nil else { return nil }
        return records.removeValue(forKey: identity.paneId)
    }

    mutating func removeAll() -> [AttachmentRecord<Value>] {
        let removed = Array(records.values)
        records.removeAll(keepingCapacity: false)
        return removed
    }
}
