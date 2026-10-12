import { useRef, useState, type KeyboardEvent } from 'react'
import type { ChatImageRef, ChatSessionInfo } from '../../shared/agent-chat'
import type { ChatStashEntry, ChatStashSource } from '../../shared/chat-stash'
import { useChatStash, type ChatStash } from './chatStash'

export type StashedDraft = { text: string; images: ChatImageRef[] }

function sourceOf(session: ChatSessionInfo): ChatStashSource {
  return {
    paneId: session.paneId,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
  }
}

/**
 * Ctrl+S, as in the Claude Code TUI: with a draft it goes to the stash and the
 * composer clears; on an empty composer the newest stashed draft comes back.
 * Ctrl+Shift+S opens the list of stashed drafts. The stash is the daemon's, so
 * every chat pane and window shares it.
 */
export function useComposerStash({ session, draft, images, uploading, clear, bringBack, setError }: {
  session: ChatSessionInfo
  draft: string
  /** The composer's uploaded images. */
  images: ChatImageRef[]
  /** An image is still uploading, so the draft can't be stashed whole yet. */
  uploading: boolean
  /** Empties the composer. */
  clear: () => void
  /** Puts a draft into the composer, before anything typed since. */
  bringBack: (draft: StashedDraft) => void
  setError: (message: string) => void
}) {
  const stash = useChatStash()
  const entries = stash?.entries ?? []
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  // One stash change at a time, so a held Ctrl+S can't pop the same entry twice.
  const busy = useRef(false)
  const active = entries.find((entry) => entry.id === activeId) ?? entries[0]
  const hasDraft = Boolean(draft.trim()) || images.length > 0 || uploading

  const run = (work: (stash: ChatStash) => Promise<void>) => {
    if (!stash || busy.current) return
    busy.current = true
    work(stash)
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => { busy.current = false })
  }

  /** Stashes the composer's draft; on failure it goes back in the composer. */
  const stashDraft = async (target: ChatStash): Promise<boolean> => {
    if (uploading) {
      setError('Wait for the images to finish uploading, then stash')
      return false
    }
    const saved: StashedDraft = { text: draft, images }
    clear()
    try {
      await target.push({ ...saved, source: sourceOf(session) })
      return true
    } catch (error) {
      bringBack(saved)
      throw error
    }
  }

  const take = async (target: ChatStash, entry: ChatStashEntry) => {
    const taken = await target.take(entry.id)
    if (!taken) {
      setError('That draft was already taken from the stash')
      return
    }
    bringBack(taken.entry)
    if (taken.missingImages) setError(`${taken.missingImages} stashed image${taken.missingImages === 1 ? ' is' : 's are'} no longer stored; attach ${taken.missingImages === 1 ? 'it' : 'them'} again`)
  }

  /** Restores an entry. A draft already in the composer is stashed first, so nothing is lost. */
  const restore = (entry: ChatStashEntry) => {
    setMenuOpen(false)
    run(async (target) => {
      if (hasDraft && !(await stashDraft(target))) return
      await take(target, entry)
    })
  }

  const remove = (entry: ChatStashEntry) => {
    const index = entries.indexOf(entry)
    setActiveId((entries[index + 1] ?? entries[index - 1])?.id ?? null)
    run(async (target) => { await target.take(entry.id) })
  }

  const openMenu = (open: boolean) => {
    setMenuOpen(open)
    setActiveId(null)
  }

  /** Handles the stash's keys; true when the composer should do nothing else with this one. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 's') {
      // Never the browser's Save dialog.
      event.preventDefault()
      // A held Ctrl+S would otherwise stash and pop the same draft by turns.
      if (event.repeat) return true
      if (event.shiftKey) openMenu(!menuOpen)
      else if (hasDraft) run(async (target) => { await stashDraft(target) })
      else if (entries[0]) {
        const latest = entries[0]
        run((target) => take(target, latest))
      }
      return true
    }
    if (!menuOpen) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setMenuOpen(false)
      return true
    }
    if (!active) {
      // Nothing to restore; Enter only closes the empty list.
      if (event.key !== 'Enter') return false
      event.preventDefault()
      setMenuOpen(false)
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const index = entries.indexOf(active)
      setActiveId(entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]!.id)
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      restore(active)
      return true
    }
    // Typing still goes to the draft, so Backspace removes an entry only from an empty composer.
    if (event.key === 'Delete' || (event.key === 'Backspace' && !hasDraft)) {
      event.preventDefault()
      remove(active)
      return true
    }
    return false
  }

  return {
    available: Boolean(stash),
    entries,
    menuOpen: menuOpen && Boolean(stash),
    activeId: active?.id ?? null,
    setActiveId,
    openMenu,
    restore,
    remove,
    onKeyDown,
  }
}
