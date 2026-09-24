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

describe('parseSessionBriefPatch references', () => {
  it('accepts flag names and labeled HTTP(S) links', () => {
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'feature_flag', value: ' new-checkout ' } }))
      .toEqual({ reference: { action: 'upsert', kind: 'feature_flag', value: 'new-checkout' } })
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'url', value: 'http://localhost:5273/checkout', label: 'Preview' } }))
      .toEqual({ reference: { action: 'upsert', kind: 'url', value: 'http://localhost:5273/checkout', label: 'Preview' } })
    expect(parseSessionBriefPatch({ reference: { action: 'remove', kind: 'url', value: 'https://example.com/' } }))
      .toEqual({ reference: { action: 'remove', kind: 'url', value: 'https://example.com/' } })
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'url', value: 'https://example.com' } }))
      .toEqual({ reference: { action: 'upsert', kind: 'url', value: 'https://example.com/' } })
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com/'])('rejects unsafe URL %s', (url) => {
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'url', value: url } })).toThrow('reference is invalid')
  })

  it('rejects malformed reference mutations', () => {
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'feature_flag', value: '' } })).toThrow()
    expect(() => parseSessionBriefPatch({ reference: { action: 'remove', kind: 'url', value: 'https://example.com/', label: 'No' } })).toThrow('reference is invalid')
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'feature_flag', value: 'flag', label: 'No' } })).toThrow('reference is invalid')
  })
})
