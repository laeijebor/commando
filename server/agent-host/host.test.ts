import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../shared/agent-chat.js'
import { snapshotItems } from './host.js'

describe('snapshotItems', () => {
  it('keeps the newest items that fit, in order', () => {
    const items = Array.from({ length: 10 }, (_, index): ChatItem => ({
      id: `i${index}`, turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'notice', level: 'info', text: 'x'.repeat(100),
    }))
    const size = JSON.stringify(items[0]).length
    expect(snapshotItems(items, size * 3).map((item) => item.id)).toEqual(['i7', 'i8', 'i9'])
    expect(snapshotItems(items)).toHaveLength(10)
  })
})
