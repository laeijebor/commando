import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- a plain ESM script without type declarations
import { acquireLock, baselineVerdict, nativeVerdict, parseUpdateGroup, planRun, updateMessage } from './mobile-ota.mjs'

describe('mobile OTA continuous delivery', () => {
  it('only checks next when it moved and the move touched the mobile app', () => {
    expect(planRun({ sha: 'b', state: { lastSeen: 'b' }, changedMobile: true })).toMatchObject({ action: 'idle' })
    expect(planRun({ sha: 'b', state: { lastPublished: 'b' }, changedMobile: true })).toMatchObject({ action: 'idle' })
    expect(planRun({ sha: 'b', state: { lastSeen: 'a', lastPublished: 'a' }, changedMobile: false })).toMatchObject({ action: 'skip' })
    expect(planRun({ sha: 'b', state: { lastSeen: 'a', lastPublished: 'a' }, changedMobile: true })).toEqual({ action: 'check' })
    // Nothing to compare against (first run, or rewritten history) counts as a change.
    expect(planRun({ sha: 'b', state: {}, changedMobile: null })).toEqual({ action: 'check' })
    expect(planRun({ sha: 'b', state: { lastSeen: 'b' }, changedMobile: false, force: true })).toEqual({ action: 'check' })
  })

  it('refuses an update the installed build cannot run', () => {
    const baseline = { runtime: '0.2.0', fingerprint: 'abc' }
    expect(nativeVerdict(baseline, { runtime: '0.2.0', fingerprint: 'abc' })).toEqual({ ok: true })
    expect(nativeVerdict(baseline, { runtime: '0.2.0', fingerprint: 'def' })).toMatchObject({ ok: false, reason: expect.stringContaining('Native code changed') })
    expect(nativeVerdict(baseline, { runtime: '0.3.0', fingerprint: 'abc' })).toMatchObject({ ok: false, reason: expect.stringContaining('0.3.0') })
    expect(nativeVerdict(undefined, { runtime: '0.2.0', fingerprint: 'abc' })).toMatchObject({ ok: false, reason: expect.stringContaining('baseline') })
  })

  it('refuses a new baseline whose native code changed under the same runtime version', () => {
    expect(baselineVerdict(undefined, { runtime: '0.2.0', fingerprint: 'a' })).toEqual({ ok: true })
    expect(baselineVerdict({ runtime: '0.2.0', fingerprint: 'a' }, { runtime: '0.2.0', fingerprint: 'a' })).toEqual({ ok: true })
    expect(baselineVerdict({ runtime: '0.2.0', fingerprint: 'a' }, { runtime: '0.3.0', fingerprint: 'b' })).toEqual({ ok: true })
    expect(baselineVerdict({ runtime: '0.2.0', fingerprint: 'a' }, { runtime: '0.2.0', fingerprint: 'b' })).toMatchObject({ ok: false, reason: expect.stringContaining('Bump expo.version') })
  })

  it('names the update after the commits it brings', () => {
    expect(updateMessage('03c722e9', ['feat: threads', 'fix: drafts'])).toBe('next 03c722e9: feat: threads; fix: drafts')
    expect(updateMessage('03c722e9', [])).toBe('next 03c722e9: mobile changes')
    expect(updateMessage('1', ['a', 'b', 'c', 'd', 'e', 'f'])).toBe('next 1: a; b; c; d; +2 more')
    expect(updateMessage('1', ['x'.repeat(600)]).length).toBe(480)
  })

  it('reads the update group from eas output', () => {
    expect(parseUpdateGroup('Branch  production\nUpdate group ID  d8d9ee48-b246-492a-837f-9d6da3bd87e7\n')).toBe('d8d9ee48-b246-492a-837f-9d6da3bd87e7')
    expect(parseUpdateGroup('nothing')).toBeUndefined()
  })

  it('takes the run lock exclusively, and only over a dead holder', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'mobile-ota-')), 'lock')
    expect(acquireLock(lock, 100, () => true)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe('100')
    expect(acquireLock(lock, 200, () => true)).toBe(false)
    expect(acquireLock(lock, 200, () => false)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe('200')
    // A lock with no pid yet is someone mid-create, until it is old.
    writeFileSync(lock, '')
    expect(acquireLock(lock, 300, () => true)).toBe(false)
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    expect(acquireLock(lock, 300, () => true)).toBe(true)
    // A contender mid-takeover blocks others; a takeover left by a crash is cleared.
    writeFileSync(`${lock}.takeover`, '1')
    expect(acquireLock(lock, 400, () => false)).toBe(false)
    utimesSync(`${lock}.takeover`, old, old)
    expect(acquireLock(lock, 400, () => false)).toBe(false)
    expect(existsSync(`${lock}.takeover`)).toBe(false)
    expect(acquireLock(lock, 400, () => false)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe('400')
  })
})
