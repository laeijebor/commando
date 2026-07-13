import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { SavedWorkspace } from '../shared/protocol.js'
import { WorkspaceStore, parseSavedWorkspace } from './workspaces.js'

const temporaryDirectories: string[] = []

async function temporaryStatePath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-test-'))
  temporaryDirectories.push(directory)
  return { directory, path: join(directory, 'nested', 'state.json') }
}

function workspace(sessionId: string, windowId: string, paneId: string): SavedWorkspace {
  return {
    sessionId,
    groups: [
      {
        id: `group-${sessionId.slice(1)}`,
        name: 'Primary',
        sessionId,
        windowId,
        paneIds: [paneId],
        layout: 'equal-grid',
      },
    ],
    updatedAt: 1234,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('workspace persistence', () => {
  it('validates ids, layouts, and duplicate group ids', () => {
    expect(parseSavedWorkspace(workspace('$1', '@2', '%3'))).not.toBeNull()
    expect(
      parseSavedWorkspace({
        ...workspace('$1', '@2', '%3'),
        sessionId: 'session-name',
      }),
    ).toBeNull()
    const duplicate = workspace('$1', '@2', '%3')
    duplicate.groups.push({ ...duplicate.groups[0] })
    expect(parseSavedWorkspace(duplicate)).toBeNull()

    const overlapping = workspace('$1', '@2', '%3')
    overlapping.groups.push({
      ...overlapping.groups[0],
      id: 'secondary',
    })
    expect(parseSavedWorkspace(overlapping)).toBeNull()
  })

  it('drops legacy outer group dimension fields', () => {
    const sized = workspace('$1', '@2', '%3')
    Object.assign(sized.groups[0], { widthPx: 960, heightPx: 640 })
    const parsed = parseSavedWorkspace(sized)
    expect(parsed).not.toBeNull()
    expect(parsed?.groups[0]).not.toHaveProperty('widthPx')
    expect(parsed?.groups[0]).not.toHaveProperty('heightPx')
  })

  it('serializes concurrent saves and leaves only the final state file', async () => {
    const { directory, path } = await temporaryStatePath()
    const store = new WorkspaceStore(path)
    await Promise.all([
      store.save(workspace('$1', '@1', '%1')),
      store.save(workspace('$2', '@2', '%2')),
    ])

    await expect(store.load('$1')).resolves.toEqual(workspace('$1', '@1', '%1'))
    await expect(store.load('$2')).resolves.toEqual(workspace('$2', '@2', '%2'))
    await expect(readdir(join(directory, 'nested'))).resolves.toEqual(['state.json'])
  })

  it('does not silently overwrite corrupt state', async () => {
    const { path } = await temporaryStatePath()
    const store = new WorkspaceStore(path)
    await store.save(workspace('$1', '@1', '%1'))
    await writeFile(path, '{not-json', 'utf8')

    await expect(store.save(workspace('$2', '@2', '%2'))).rejects.toThrow(
      'invalid JSON',
    )
  })
})
