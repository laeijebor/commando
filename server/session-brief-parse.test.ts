import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { parseSessionBriefPatch } from './session-brief-api.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('parseSessionBriefPatch screenshots', () => {
  it('accepts an absolute existing directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'commando-session-brief-parse-'))
    directories.push(parent)
    const shots = join(parent, 'shots')
    await mkdir(shots)

    expect(parseSessionBriefPatch({ screenshots: { dir: shots } })).toEqual({ screenshots: { dir: realpathSync(shots) } })
  })

  it('rejects relative and missing directories', () => {
    expect(() => parseSessionBriefPatch({ screenshots: { dir: 'relative/shots' } })).toThrow('absolute path')
    expect(() => parseSessionBriefPatch({ screenshots: { dir: '/definitely/missing/commando-shots' } })).toThrow('must exist')
  })
})
