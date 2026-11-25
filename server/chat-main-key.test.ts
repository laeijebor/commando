import { describe, expect, it } from 'vitest'
import { isMainChatKey } from './chat-main-key.js'

describe('pane-level chat discovery and ask attribution', () => {
  it('keeps parent panes and excludes aside keys for conversation lists, sent-message search and answersAsk', () => {
    const chats = [{ paneId: '%4' }, { paneId: '%4~abcd1234' }, { paneId: '%9' }]
    expect(chats.filter((chat) => isMainChatKey(chat.paneId))).toEqual([chats[0], chats[2]])
    expect(isMainChatKey('%4~abcd1234')).toBe(false)
  })
})
