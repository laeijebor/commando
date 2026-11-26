import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAsideKey, parseChatAsideRecords, type ChatState } from '../shared/agent-chat.js'
import { asideStoreDirectory } from './agent-host/asides.js'

/** Pane-level discovery and ask attribution exclude independent aside threads. */
export function isMainChatKey(paneId: string): boolean {
  return !parseAsideKey(paneId)
}

/** Picker exclusions include saved (even closed) asides and hosts not yet in those records. */
export function asideSessionIds(chats: readonly Pick<ChatState, 'paneId' | 'session' | 'asides'>[], persisted: Iterable<string> = []): Set<string> {
  const ids = new Set(persisted)
  for (const chat of chats) {
    for (const aside of chat.asides ?? []) {
      if (aside.sessionId && aside.status !== 'promoted') ids.add(aside.sessionId)
    }
    if (!isMainChatKey(chat.paneId) && chat.session.sessionId) ids.add(chat.session.sessionId)
  }
  return ids
}

/** Picker-only history: aside records outlive their parent host and daemon. */
export class PersistedAsideSessions {
  private directoryMtime?: number
  private names: string[] = []
  private files = new Map<string, { mtime: number; ctime: number; ids: string[] }>()

  constructor(private readonly directory = asideStoreDirectory()) {}

  async sessionIds(): Promise<Set<string>> {
    try {
      const directory = await stat(this.directory)
      if (directory.mtimeMs !== this.directoryMtime) {
        // Atomic-write temporaries and quarantined .bad-* files have suffixes after .json.
        this.names = (await readdir(this.directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name)
        this.directoryMtime = directory.mtimeMs
      }
    } catch {
      this.directoryMtime = undefined
      this.names = []
      this.files.clear()
      return new Set()
    }
    const files = new Map<string, { mtime: number; ctime: number; ids: string[] }>()
    await Promise.all(this.names.map(async (name) => {
      try {
        const path = join(this.directory, name)
        const info = await stat(path)
        if (!info.isFile()) return
        const cached = this.files.get(name)
        if (cached && cached.mtime === info.mtimeMs && cached.ctime === info.ctimeMs) {
          files.set(name, cached)
          return
        }
        let ids: string[] = []
        try {
          const value: unknown = JSON.parse(await readFile(path, 'utf8'))
          const records = typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'asides' in value
            ? parseChatAsideRecords(value.asides) : null
          ids = records?.flatMap((record) => record.sessionId && record.status !== 'promoted' ? [record.sessionId] : []) ?? []
        } catch (error) {
          if (!(error instanceof SyntaxError)) return
        }
        files.set(name, { mtime: info.mtimeMs, ctime: info.ctimeMs, ids })
      } catch { /* Missing or unreadable files must not break conversation listing. */ }
    }))
    this.files = files
    return new Set([...files.values()].flatMap((file) => file.ids))
  }
}
