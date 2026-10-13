import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isChatImageId, type ChatCarriedDraft, type ChatHandoffInfo, type ChatImageRef, type ChatQueuedMessage } from '../shared/agent-chat.js'
import { tmuxServerStateSuffix } from './agent-resume.js'
import { isValidAgentSessionId } from './agent-resume-command.js'

/**
 * A chat conversation running in its provider's TUI since a switch: what the chat
 * held (its unsent draft and queue) and the flags that bring the chat back.
 */
export type ChatHandoff = ChatHandoffInfo & {
  /** The chat's folder: Claude resumes a conversation from the folder it was saved in. */
  cwd: string
  /** The chat host's session flags (profile, model, effort, modes). */
  returnFlags: string[]
  draft: { text: string; images: ChatImageRef[] }
  queue: ChatQueuedMessage[]
  /** Names what the chat offers back, so a composer takes it once. */
  carryId: string
  createdAt: number
  /** The chat is back; the entry only holds what no composer has taken yet. */
  returnedAt?: number
}

const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_ENTRIES = 256

export function defaultChatHandoffPath(): string {
  return process.env.COMMANDO_CHAT_HANDOFFS_PATH ?? join(homedir(), '.commando', `chat-handoffs${tmuxServerStateSuffix()}.json`)
}

function validImages(value: unknown): value is ChatImageRef[] {
  return Array.isArray(value) && value.every((image) => image && typeof image === 'object' && isChatImageId((image as ChatImageRef).id)
    && ((image as ChatImageRef).name === undefined || typeof (image as ChatImageRef).name === 'string'))
}

function validEntry(value: unknown): value is ChatHandoff {
  if (!value || typeof value !== 'object') return false
  const entry = value as ChatHandoff
  return typeof entry.sessionId === 'string' && isValidAgentSessionId(entry.sessionId)
    && (entry.provider === undefined || entry.provider === 'claude' || entry.provider === 'codex')
    && (entry.paneId === undefined || /^%\d+$/.test(entry.paneId))
    && typeof entry.cwd === 'string' && entry.cwd.startsWith('/')
    && Array.isArray(entry.returnFlags) && entry.returnFlags.every((flag) => typeof flag === 'string')
    && !!entry.draft && typeof entry.draft.text === 'string' && validImages(entry.draft.images)
    && Array.isArray(entry.queue) && entry.queue.every((queued) => queued && typeof queued.id === 'string' && typeof queued.text === 'string'
      && (queued.images === undefined || validImages(queued.images)))
    && typeof entry.carryId === 'string' && Number.isFinite(entry.createdAt)
    && (entry.returnedAt === undefined || Number.isFinite(entry.returnedAt))
}

/** The queue first (it was written earlier), then the draft, as Stop brings them back. */
export function carriedDraft(entry: ChatHandoff): ChatCarriedDraft | undefined {
  const text = [...entry.queue.map((queued) => queued.text), entry.draft.text].map((part) => part.trim()).filter(Boolean).join('\n\n')
  const images = [...entry.queue.flatMap((queued) => queued.images ?? []), ...entry.draft.images]
  return text || images.length ? { id: entry.carryId, text, images } : undefined
}

/**
 * Chats switched to Claude Code, by conversation. Kept on disk so a daemon or
 * tmux restart mid-switch keeps both the way back and what the chat held.
 */
export class ChatHandoffStore {
  private entries = new Map<string, ChatHandoff>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    readonly path = defaultChatHandoffPath(),
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state?.version !== 1 || !Array.isArray(state.entries)) throw new Error('Invalid chat handoff state')
      const cutoff = this.now() - ENTRY_TTL_MS
      for (const entry of state.entries) {
        if (validEntry(entry) && entry.createdAt >= cutoff) this.entries.set(entry.sessionId, entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.onError(error)
      // Keep what can't be read for a person to look at, rather than write over it.
      await rename(this.path, `${this.path}.corrupt-${this.now()}`).catch(this.onError)
    }
  }

  get(sessionId: string): ChatHandoff | undefined {
    return this.entries.get(sessionId)
  }

  /** Conversations running in Claude Code that started as a chat. */
  inClaudeCode(): string[] {
    return [...this.entries.values()].filter((entry) => entry.returnedAt === undefined).map((entry) => entry.sessionId)
  }

  /** Active handoffs retain the provider and pane even before a TUI emits hooks. */
  active(): ChatHandoffInfo[] {
    return this.activeEntries()
      .map(({ sessionId, paneId, provider }) => ({ sessionId, paneId, provider }))
  }

  forPane(paneId: string): ChatHandoff | undefined {
    return this.activeEntries().find((entry) => entry.paneId === paneId)
  }

  private activeEntries(): ChatHandoff[] {
    return [...this.entries.values()].filter((entry) => entry.returnedAt === undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  /** Records a switch; resolves once it is on disk. A switch that can't be kept isn't recorded. */
  async save(entry: Omit<ChatHandoff, 'carryId' | 'createdAt' | 'returnedAt'>): Promise<void> {
    const previous = this.entries.get(entry.sessionId)
    this.entries.set(entry.sessionId, { ...entry, carryId: randomUUID(), createdAt: this.now() })
    try {
      await this.persist()
    } catch (error) {
      if (previous) this.entries.set(entry.sessionId, previous)
      else this.entries.delete(entry.sessionId)
      this.persistQuietly()
      throw error
    }
  }

  /** A switch the chat gave up on after it was saved (the host timed out waiting): the chat kept its queue. */
  discard(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.returnedAt !== undefined) return false
    this.entries.delete(sessionId)
    this.persistQuietly()
    return true
  }

  /**
   * The chat is back on this conversation: what it held, until a composer
   * takes it. Nothing to give back ends the entry.
   */
  returned(sessionId: string): ChatCarriedDraft | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    const carried = carriedDraft(entry)
    if (!carried) {
      this.entries.delete(sessionId)
      this.persistQuietly()
      return undefined
    }
    if (entry.returnedAt === undefined) {
      this.entries.set(sessionId, { ...entry, returnedAt: this.now() })
      this.persistQuietly()
    }
    return carried
  }

  /**
   * A composer took what the chat carried back: its text, and the first
   * `imagesTaken` images (all when omitted). Images that didn't fit stay here,
   * offered again under a new id; that remainder is returned.
   */
  take(sessionId: string, carryId: string, imagesTaken?: number): ChatCarriedDraft | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.carryId !== carryId || entry.returnedAt === undefined) return undefined
    const images = carriedDraft(entry)?.images ?? []
    const left = imagesTaken === undefined ? [] : images.slice(imagesTaken)
    if (!left.length) {
      this.entries.delete(sessionId)
      this.persistQuietly()
      return undefined
    }
    const rest: ChatHandoff = { ...entry, draft: { text: '', images: left }, queue: [], carryId: randomUUID() }
    this.entries.set(sessionId, rest)
    this.persistQuietly()
    return carriedDraft(rest)
  }

  /** Resolves once queued writes have reached disk. */
  flush(): Promise<void> {
    return this.writes
  }

  /** For writes nobody waits on; a failure is reported through onError. */
  private persistQuietly(): void {
    this.persist().catch(() => undefined)
  }

  private persist(): Promise<void> {
    const entries = [...this.entries.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_ENTRIES)
    if (entries.length < this.entries.size) this.entries = new Map(entries.map((entry) => [entry.sessionId, entry]))
    const write = this.writes.then(() => this.write(entries))
    this.writes = write.catch(this.onError)
    return write
  }

  private async write(entries: ChatHandoff[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      await rename(temporary, this.path)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
