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

  it('accepts plain resume commands and rejects anything a shell could chain or expand', () => {
    for (const value of ['opencode --yolo -s ses_f08700672ffenN8gLm9kPx2xb6', 'claudew --resume d227943a-841a-4dfa-94c7-afe2e0774487']) {
      expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'session', value } }).reference)
        .toEqual({ action: 'upsert', kind: 'session', value })
    }
    for (const value of ['claudep --resume x; rm -rf /', 'claudep --resume $(id)', 'a && b', 'a | b', 'a `b`', "a 'b'", 'a\nb', '-s x', `a ${'b'.repeat(300)}`]) {
      expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'session', value } })).toThrow()
    }
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'session', value: 'claudep --resume x', label: 'No' } })).toThrow('reference is invalid')
  })

  it('accepts issue and deployment links and optionally linked build/release IDs', () => {
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'issue', value: 'https://github.com/acme/app/issues/42', label: 'Bug #42' } }).reference)
      .toEqual({ action: 'upsert', kind: 'issue', value: 'https://github.com/acme/app/issues/42', label: 'Bug #42' })
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'deployment', value: 'https://preview.example.com', label: 'Preview' } }).reference)
      .toEqual({ action: 'upsert', kind: 'deployment', value: 'https://preview.example.com/', label: 'Preview' })
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'build', value: '1842', url: 'https://ci.example.com/build/1842' } }).reference)
      .toEqual({ action: 'upsert', kind: 'build', value: '1842', url: 'https://ci.example.com/build/1842' })
    expect(parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'release', value: 'v2.3.0' } }).reference)
      .toEqual({ action: 'upsert', kind: 'release', value: 'v2.3.0' })
  })

  it('rejects unsafe links and invalid kind-specific fields', () => {
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'issue', value: 'javascript:alert(1)' } })).toThrow('reference is invalid')
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'deployment', value: 'https://user:password@example.com' } })).toThrow('reference is invalid')
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'build', value: '1842', url: 'file:///tmp/build' } })).toThrow('reference is invalid')
    expect(() => parseSessionBriefPatch({ reference: { action: 'upsert', kind: 'release', value: 'v2', label: 'wrong' } })).toThrow('reference is invalid')
    expect(() => parseSessionBriefPatch({ reference: { action: 'remove', kind: 'build', value: '1842', url: 'https://ci.example.com/' } })).toThrow('reference is invalid')
  })
})
