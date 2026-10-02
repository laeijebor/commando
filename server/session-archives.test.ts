import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionArchives } from './session-archives.js'
import { parseWindowLayout, type WindowLayoutNode } from '../shared/window-layout.js'

const exec = promisify(execFile)
const socket = `commando-archive-test-${process.pid}`
const tmux = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args])).stdout.trimEnd()
const directories: string[] = []
const shape = (node: WindowLayoutNode): string => node.kind === 'pane' ? 'pane' : `${node.direction}(${node.children.map(shape).join(',')})`

afterEach(async () => {
  await tmux('kill-session', '-t', 'keep').catch(() => undefined)
  await tmux('kill-session', '-t', 'restored').catch(() => undefined)
  await tmux('kill-session', '-t', 'collision').catch(() => undefined)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('per-session tmux archives', () => {
  it('kills only the selected session, then restores its named windows, split panes and directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-archive-'))
    directories.push(directory)
    const archives = new SessionArchives({ directory, environment: { COMMANDO_TMUX_SOCKET_NAME: socket } })
    await tmux('new-session', '-d', '-s', 'keep')
    const sessionId = await tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'restored', '-n', 'editor', '-c', tmpdir())
    const initialPane = await tmux('display-message', '-p', '-t', sessionId, '#{pane_id}')
    const rightPane = await tmux('split-window', '-d', '-h', '-P', '-F', '#{pane_id}', '-t', initialPane, '-c', directory)
    await tmux('split-window', '-d', '-v', '-t', rightPane, '-c', tmpdir())
    await tmux('select-pane', '-t', initialPane, '-T', 'Plan')
    await tmux('new-window', '-d', '-t', sessionId, '-n', 'tests', '-c', directory)
    await tmux('move-window', '-s', `${sessionId}:1`, '-t', `${sessionId}:8`)
    await tmux('move-window', '-s', `${sessionId}:0`, '-t', `${sessionId}:4`)
    await tmux('select-window', '-t', `${sessionId}:4`)
    const before = await tmux('list-windows', '-t', sessionId, '-F', '#{window_index} #{window_name} #{window_panes} #{window_active}')
    const originalShape = shape(parseWindowLayout(await tmux('display-message', '-p', '-t', `${sessionId}:4`, '#{window_layout}'))!)
    const summary = await archives.archive(sessionId, 'restored')
    expect(summary).toMatchObject({ name: 'restored', windowCount: 2, paneCount: 4 })
    await expect(tmux('has-session', '-t', sessionId)).rejects.toThrow()
    expect(await tmux('has-session', '-t', '=keep')).toBe('')
    expect(await archives.list()).toHaveLength(1)
    expect(await new SessionArchives({ directory, environment: { COMMANDO_TMUX_SOCKET_NAME: socket } }).list()).toHaveLength(1)

    const newSessionId = await archives.restore(summary.id)
    expect(newSessionId).not.toBe(sessionId)
    expect(await tmux('list-windows', '-t', newSessionId, '-F', '#{window_index} #{window_name} #{window_panes} #{window_active}')).toBe(before)
    expect(shape(parseWindowLayout(await tmux('display-message', '-p', '-t', `${newSessionId}:4`, '#{window_layout}'))!)).toBe(originalShape)
    const panes = await tmux('list-panes', '-t', `${newSessionId}:4`, '-F', '#{pane_current_path}')
    expect(panes.split('\n')).toEqual([await realpath(tmpdir()), await realpath(directory), await realpath(tmpdir())])
    expect(await tmux('list-panes', '-t', `${newSessionId}:4`, '-F', '#{pane_title}')).toContain('Plan')
    expect(await archives.list()).toEqual([])
    expect(await tmux('has-session', '-t', '=keep')).toBe('')
  })

  it('keeps the archive if restoration conflicts with a live session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-archive-'))
    directories.push(directory)
    const archives = new SessionArchives({ directory, environment: { COMMANDO_TMUX_SOCKET_NAME: socket } })
    await tmux('new-session', '-d', '-s', 'keep')
    const id = await tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'collision')
    const archived = await archives.archive(id, 'collision')
    await tmux('new-session', '-d', '-s', 'collision')
    await expect(archives.restore(archived.id)).rejects.toThrow('already exists')
    expect(await archives.list()).toHaveLength(1)
  })

  it('keeps the original session and leaves no archive when tmux cannot kill it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-archive-'))
    directories.push(directory)
    await tmux('new-session', '-d', '-s', 'keep')
    const sessionId = await tmux('new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'restored')
    const archives = new SessionArchives({ directory, environment: { COMMANDO_TMUX_SOCKET_NAME: socket }, execute: async (_, args) => {
      if (args.includes('kill-session')) throw new Error('tmux refused to kill the session')
      const { stdout, stderr } = await exec('tmux', [...args])
      return { stdout, stderr }
    } })
    await expect(archives.archive(sessionId, 'restored')).rejects.toThrow('tmux refused')
    expect(await tmux('has-session', '-t', sessionId)).toBe('')
    expect(await archives.list()).toEqual([])
  })
})
