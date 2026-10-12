import { watch, type FSWatcher } from 'node:fs'
import type { WebPane } from '../shared/protocol.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'

type WatchedCanvas = { watcher: FSWatcher; changed: Set<string>; timer?: ReturnType<typeof setTimeout> }

export class CanvasWatch {
  private readonly watched = new Map<string, WatchedCanvas>()

  constructor(
    private readonly artifacts: Pick<RedlineArtifactRegistry, 'directory'>,
    private readonly notify: (change: { artifactId: string; changed: string[] }) => void,
    private readonly watchDirectory: typeof watch = watch,
  ) {}

  sync(panes: readonly WebPane[]): void {
    const ids = new Set(panes.flatMap((pane) => pane.content?.kind === 'canvas' ? [pane.content.artifactId] : []))
    for (const [id, entry] of this.watched) {
      if (!ids.has(id) || !this.artifacts.directory(id)) this.stop(id, entry)
    }
    for (const id of ids) {
      if (this.watched.has(id)) continue
      const dir = this.artifacts.directory(id)
      if (!dir) continue
      try {
        const watcher = this.watchDirectory(dir, { recursive: true }, (_event, filename) => {
          const entry = this.watched.get(id)
          if (!entry) return
          entry.changed.add(filename ? filename.toString().replaceAll('\\', '/') : '*')
          clearTimeout(entry.timer)
          entry.timer = setTimeout(() => {
            const changed = [...entry.changed].sort()
            entry.changed.clear()
            this.notify({ artifactId: id, changed })
          }, 150)
        })
        const entry: WatchedCanvas = { watcher, changed: new Set() }
        this.watched.set(id, entry)
        watcher.on('error', (error) => {
          console.warn('[commando] canvas watcher failed', error)
          this.stop(id, entry)
        })
      } catch (error) { console.warn('[commando] canvas watch unavailable', error) }
    }
  }

  close(): void {
    for (const [id, entry] of this.watched) this.stop(id, entry)
  }

  private stop(id: string, entry: WatchedCanvas): void {
    clearTimeout(entry.timer)
    entry.watcher.close()
    this.watched.delete(id)
  }
}
