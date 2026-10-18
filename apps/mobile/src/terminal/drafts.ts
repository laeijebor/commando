import { create } from 'zustand'

const MAX_DRAFTS = 100
export const useTerminalDrafts = create<{ drafts: Record<string, string>; setDraft: (key: string, text: string) => void }>((set, get) => ({
  drafts: {},
  setDraft: (key, text) => {
    const drafts = { ...get().drafts }
    delete drafts[key]
    if (text) drafts[key] = text
    while (Object.keys(drafts).length > MAX_DRAFTS) delete drafts[Object.keys(drafts)[0]!]
    set({ drafts })
  },
}))
