import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { layoutTreePanes, parseWindowLayout, type WindowLayoutNode } from '../shared/window-layout.js'
import { tmuxSocketArgs, validateTmuxSessionId, validateTmuxSessionName, type TmuxProcessExecutor, type TmuxSocketEnvironment } from './tmux-session-actions.js'

const SEP = '\u001f'
const ARCHIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPTIONS = { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, timeout: 5_000, windowsHide: true } as const
const PANE_FORMAT = ['#{pane_id}', '#{pane_index}', '#{pane_current_path}', '#{pane_title}', '#{pane_active}'].join(SEP)
const WINDOW_FORMAT = ['#{window_id}', '#{window_index}', '#{window_name}', '#{window_layout}', '#{window_active}'].join(SEP)

export type ArchivedPane = { id: string; index: number; path: string; title: string; active: boolean }
export type ArchivedWindow = { index: number; name: string; layout: WindowLayoutNode; panes: ArchivedPane[]; active: boolean }
export type SessionArchive = { version: 1; id: string; name: string; createdAt: number; windows: ArchivedWindow[] }
export type ArchiveSummary = { id: string; name: string; createdAt: number; windowCount: number; paneCount: number }

const defaultExecutor: TmuxProcessExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message))
    else resolve({ stdout, stderr })
  })
})

function lines(output: string): string[][] {
  return output.trimEnd().split('\n').filter(Boolean).map((line) => line.split(SEP))
}

function checksum(body: string): string {
  let sum = 0
  for (const byte of Buffer.from(body)) sum = (((sum >> 1) | ((sum & 1) << 15)) + byte) & 0xffff
  return sum.toString(16).padStart(4, '0')
}

function restoredLayout(node: WindowLayoutNode, paneNumbers: Map<string, number>): string {
  const geometry = `${node.cols}x${node.rows},${node.left},${node.top}`
  if (node.kind === 'pane') {
    const paneNumber = paneNumbers.get(node.paneId)
    if (paneNumber === undefined) throw new Error('Archived layout references a missing pane')
    return `${geometry},${paneNumber}`
  }
  const open = node.direction === 'row' ? '{' : '['
  const close = node.direction === 'row' ? '}' : ']'
  return `${geometry}${open}${node.children.map((child) => restoredLayout(child, paneNumbers)).join(',')}${close}`
}

function validArchive(value: unknown): value is SessionArchive {
  if (!value || typeof value !== 'object') return false
  const archive = value as SessionArchive
  if (archive.version !== 1 || !ARCHIVE_ID.test(archive.id) || !Number.isFinite(archive.createdAt)) return false
  try { validateTmuxSessionName(archive.name) } catch { return false }
  if (!Array.isArray(archive.windows) || archive.windows.length === 0 || archive.windows.length > 128) return false
  return archive.windows.every((window) =>
    Number.isSafeInteger(window.index) && window.index >= 0 && typeof window.name === 'string' && window.name.length > 0 &&
    typeof window.active === 'boolean' && Array.isArray(window.panes) && window.panes.length > 0 && window.panes.length <= 32 &&
    window.panes.every((pane) => /^%\d+$/.test(pane.id) && Number.isSafeInteger(pane.index) && pane.index >= 0 &&
      typeof pane.path === 'string' && pane.path.startsWith('/') && !pane.path.includes('\0') &&
      typeof pane.title === 'string' && typeof pane.active === 'boolean') &&
    window.layout && layoutTreePanes(window.layout).length === window.panes.length &&
    layoutTreePanes(window.layout).every((pane) => window.panes.some((item) => item.id === pane.paneId)),
  )
}

export class SessionArchives {
  private readonly socketArgs: string[]
  private readonly directory: string
  private readonly execute: TmuxProcessExecutor

  constructor(options: { directory?: string; execute?: TmuxProcessExecutor; environment?: TmuxSocketEnvironment } = {}) {
    this.socketArgs = tmuxSocketArgs(options.environment ?? process.env)
    this.directory = options.directory ?? process.env.COMMANDO_SESSION_ARCHIVES_DIR ?? join(homedir(), '.commando', 'session-archives')
    this.execute = options.execute ?? defaultExecutor
  }

  private async run(args: string[]): Promise<string> {
    return (await this.execute('tmux', [...this.socketArgs, ...args], OPTIONS)).stdout.trimEnd()
  }

  private path(id: string): string {
    if (!ARCHIVE_ID.test(id)) throw new Error('Invalid archive id')
    return join(this.directory, `${id}.json`)
  }

  async list(): Promise<ArchiveSummary[]> {
    let files: string[]
    try { files = await readdir(this.directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const archives = await Promise.all(files.filter((file) => file.endsWith('.json') && ARCHIVE_ID.test(file.slice(0, -5)))
      .map(async (file) => this.read(file.slice(0, -5))))
    return archives.map(({ id, name, createdAt, windows }) => ({
      id, name, createdAt, windowCount: windows.length, paneCount: windows.reduce((count, window) => count + window.panes.length, 0),
    })).sort((a, b) => b.createdAt - a.createdAt)
  }

  private async read(id: string): Promise<SessionArchive> {
    const value: unknown = JSON.parse(await readFile(this.path(id), 'utf8'))
    if (!validArchive(value) || value.id !== id) throw new Error('Invalid session archive')
    return value
  }

  async archive(sessionId: string, name: string): Promise<ArchiveSummary> {
    validateTmuxSessionId(sessionId)
    validateTmuxSessionName(name)
    const windows: ArchivedWindow[] = []
    for (const fields of lines(await this.run(['list-windows', '-t', sessionId, '-F', WINDOW_FORMAT]))) {
      if (fields.length !== 5 || !/^@\d+$/.test(fields[0])) throw new Error('Could not capture tmux windows')
      const [windowId, index, windowName, rawLayout, active] = fields
      const layout = parseWindowLayout(rawLayout)
      if (!layout) throw new Error('Could not capture tmux pane layout')
      const panes: ArchivedPane[] = lines(await this.run(['list-panes', '-t', windowId, '-F', PANE_FORMAT])).map((parts) => {
        if (parts.length !== 5 || !/^%\d+$/.test(parts[0]) || !parts[2].startsWith('/')) throw new Error('Could not capture tmux pane')
        return { id: parts[0], index: Number(parts[1]), path: parts[2], title: parts[3], active: parts[4] === '1' }
      })
      windows.push({ index: Number(index), name: windowName, layout, panes, active: active === '1' })
    }
    const archive: SessionArchive = { version: 1, id: randomUUID(), name, createdAt: Date.now(), windows }
    if (!validArchive(archive)) throw new Error('Could not capture a complete session archive')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(archive.id)
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(archive)}\n`); await handle.sync() }
    catch (error) { await handle.close(); await rm(path, { force: true }); throw error }
    await handle.close()
    try { await this.run(['kill-session', '-t', sessionId]) }
    catch (error) { await rm(path, { force: true }); throw error }
    return { id: archive.id, name, createdAt: archive.createdAt, windowCount: windows.length, paneCount: windows.reduce((count, window) => count + window.panes.length, 0) }
  }

  async restore(id: string): Promise<string> {
    const archive = await this.read(id)
    // Exact-name targets avoid matching similarly prefixed sessions.
    try {
      await this.run(['has-session', '-t', `=${archive.name}`])
      throw new Error(`A tmux session named “${archive.name}” already exists`)
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) throw error
    }
    // Verify all directories before creating anything; tmux cannot restore a deleted worktree.
    for (const window of archive.windows) for (const pane of window.panes) {
      const exists = await stat(pane.path).then((value) => value.isDirectory(), () => false)
      if (!exists) throw new Error(`Pane directory no longer exists: ${pane.path}`)
    }

    let sessionId: string | null = null
    try {
      for (const [position, window] of archive.windows.entries()) {
        const first = layoutTreePanes(window.layout)[0]
        const firstPath = window.panes.find((pane) => pane.id === first.paneId)!.path
        const args: string[] = position === 0
          ? ['new-session', '-d', '-P', '-F', '#{session_id}\u001f#{window_id}\u001f#{pane_id}', '-s', archive.name, '-n', window.name, '-c', firstPath]
          : ['new-window', '-d', '-P', '-F', '#{session_id}\u001f#{window_id}\u001f#{pane_id}', '-t', `${sessionId}:${window.index}`, '-n', window.name, '-c', firstPath]
        const createdFields: string[] = (await this.run(args)).split(SEP)
        const [createdSession, windowId, paneId] = createdFields
        if (!/^\$\d+$/.test(createdSession) || !/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) throw new Error('tmux did not create the archived window')
        sessionId = createdSession
        if (position === 0) await this.run(['move-window', '-s', windowId, '-t', `${sessionId}:${window.index}`]).catch(async (error) => {
          // The first window may already occupy its saved index.
          const index = await this.run(['display-message', '-p', '-t', windowId, '#{window_index}'])
          if (Number(index) !== window.index) throw error
        })
        const created = new Map<string, string>([[first.paneId, paneId]])
        const build = async (node: WindowLayoutNode, existing: string): Promise<void> => {
          if (node.kind === 'pane') return
          const anchors = [existing]
          for (const child of node.children.slice(1)) {
            const firstChild = layoutTreePanes(child)[0]
            const path = window.panes.find((pane) => pane.id === firstChild.paneId)!.path
            const newPane = await this.run(['split-window', '-d', node.direction === 'row' ? '-h' : '-v', '-P', '-F', '#{pane_id}', '-t', anchors[anchors.length - 1], '-c', path])
            if (!/^%\d+$/.test(newPane)) throw new Error('tmux did not create the archived pane')
            created.set(firstChild.paneId, newPane)
            anchors.push(newPane)
          }
          for (let i = 0; i < node.children.length; i++) await build(node.children[i], anchors[i])
        }
        await build(window.layout, paneId)
        const paneNumbers = new Map<string, number>()
        for (const [oldId, newId] of created) {
          paneNumbers.set(oldId, Number(newId.slice(1)))
          const title = window.panes.find((pane) => pane.id === oldId)!.title
          if (title) await this.run(['select-pane', '-t', newId, '-T', title])
        }
        const body = restoredLayout(window.layout, paneNumbers)
        await this.run(['select-layout', '-t', windowId, `${checksum(body)},${body}`])
        const activePane = window.panes.find((pane) => pane.active)
        if (activePane) await this.run(['select-pane', '-t', created.get(activePane.id)!])
        if (window.active) await this.run(['select-window', '-t', windowId])
      }
    } catch (error) {
      if (sessionId) await this.run(['kill-session', '-t', sessionId]).catch(() => undefined)
      throw error
    }
    await rm(this.path(id))
    return sessionId!
  }
}
