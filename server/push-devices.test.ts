import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_PUSH_DEVICES,
  PushDeviceError,
  PushDeviceRegistry,
  defaultPushDevicesPath,
  validatePushDeviceInput,
  type PushDeviceInput,
} from './push-devices.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function registry(): Promise<PushDeviceRegistry> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-push-devices-'))
  directories.push(directory)
  return new PushDeviceRegistry(join(directory, 'nested', 'push-devices.json'))
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
    name: 'iPhone',
    platform: 'ios',
    rules: { needsInput: true, done: true, failed: true, mutedSessions: [] },
    ...overrides,
  }
}

function input(id: string, overrides: Record<string, unknown> = {}): PushDeviceInput {
  return validatePushDeviceInput(id, body(overrides))
}

describe('push device validation', () => {
  it('accepts both Expo token spellings and trims the name', () => {
    expect(input('phone-1').expoPushToken).toBe('ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]')
    const modern = input('phone-1', {
      expoPushToken: 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
      name: '  Pixel  ',
      platform: 'android',
    })
    expect(modern.expoPushToken).toBe('ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]')
    expect(modern.name).toBe('Pixel')
    expect(modern.platform).toBe('android')
  })

  it('rejects malformed ids, tokens, names, platforms and rules', () => {
    expect(() => validatePushDeviceInput('bad id', body())).toThrow(PushDeviceError)
    expect(() => validatePushDeviceInput('a'.repeat(65), body())).toThrow(PushDeviceError)
    expect(() => validatePushDeviceInput('phone', body({ expoPushToken: 'nope' }))).toThrow(/expoPushToken/)
    expect(() => validatePushDeviceInput('phone', body({ name: '' }))).toThrow(/name/)
    expect(() => validatePushDeviceInput('phone', body({ name: 'x'.repeat(81) }))).toThrow(/name/)
    expect(() => validatePushDeviceInput('phone', body({ platform: 'web' }))).toThrow(/platform/)
    expect(() => validatePushDeviceInput('phone', body({ rules: { needsInput: true, done: true } }))).toThrow(/rules.failed/)
    expect(() => validatePushDeviceInput('phone', body({ id: 'other' }))).toThrow(/id does not match/)
  })

  it('validates quiet hours and muted sessions', () => {
    expect(() => validatePushDeviceInput('phone', body({
      rules: { needsInput: true, done: true, failed: true, quietHours: { start: '25:00', end: '07:00', timeZone: 'Europe/Berlin' } },
    }))).toThrow(/quietHours.start/)
    expect(() => validatePushDeviceInput('phone', body({
      rules: { needsInput: true, done: true, failed: true, quietHours: { start: '23:00', end: '07:00', timeZone: 'Mars/Olympus' } },
    }))).toThrow(/timeZone/)
    expect(() => validatePushDeviceInput('phone', body({
      rules: { needsInput: true, done: true, failed: true, mutedSessions: Array.from({ length: 65 }, (_, index) => `s${index}`) },
    }))).toThrow(/at most 64/)
    const parsed = validatePushDeviceInput('phone', body({
      rules: {
        needsInput: false,
        done: true,
        failed: true,
        quietHours: { start: '23:00', end: '07:30', timeZone: 'Europe/Berlin' },
        mutedSessions: ['island', 'island', 'redline'],
      },
    }))
    expect(parsed.rules.quietHours).toEqual({ start: '23:00', end: '07:30', timeZone: 'Europe/Berlin' })
    expect(parsed.rules.mutedSessions).toEqual(['island', 'redline'])
  })
})

describe('push device registry', () => {
  it('upserts by id, preserves createdAt, and persists at mode 0600', async () => {
    const store = await registry()
    const created = await store.upsert(input('phone-1'), 1_000)
    expect(created.createdAt).toBe(1_000)

    const updated = await store.upsert(input('phone-1', { name: 'iPhone 17' }), 2_000)
    expect(updated.createdAt).toBe(1_000)
    expect(updated.updatedAt).toBe(2_000)
    expect(store.list()).toHaveLength(1)
    expect(store.get('phone-1')?.name).toBe('iPhone 17')

    const stats = await stat(store.statePath)
    expect(stats.mode & 0o777).toBe(0o600)

    const reloaded = new PushDeviceRegistry(store.statePath)
    await reloaded.load()
    expect(reloaded.list()).toEqual(store.list())
  })

  it('caps the registry at 16 devices but still allows updates', async () => {
    const store = await registry()
    for (let index = 0; index < MAX_PUSH_DEVICES; index += 1) {
      await store.upsert(input(`phone-${index}`), 1_000 + index)
    }
    await expect(store.upsert(input('phone-overflow'))).rejects.toMatchObject({ status: 409 })
    await expect(store.upsert(input('phone-0', { name: 'Renamed' }))).resolves.toMatchObject({ name: 'Renamed' })
    expect(store.list()).toHaveLength(MAX_PUSH_DEVICES)
  })

  it('removes devices by id and by rejected Expo token', async () => {
    const store = await registry()
    await store.upsert(input('phone-1'), 1_000)
    await store.upsert(input('phone-2', { expoPushToken: 'ExpoPushToken[cccccccccccccccccccccc]' }), 2_000)

    expect(await store.remove('missing')).toBe(false)
    expect(await store.remove('phone-1')).toBe(true)
    expect(await store.removeByToken('ExpoPushToken[cccccccccccccccccccccc]')).toEqual(['phone-2'])
    expect(store.list()).toEqual([])

    const persisted = JSON.parse(await readFile(store.statePath, 'utf8')) as { devices: unknown[] }
    expect(persisted.devices).toEqual([])
  })

  it('drops unparseable entries on load and tolerates a missing file', async () => {
    const store = await registry()
    await store.upsert(input('phone-1'), 1_000)
    await writeFile(store.statePath, JSON.stringify({
      version: 1,
      devices: [
        { id: 'phone-1', ...body(), createdAt: 1_000, updatedAt: 1_000 },
        { id: 'broken', expoPushToken: 'nope', name: 'x', platform: 'ios', rules: {} },
      ],
    }), 'utf8')
    await store.load()
    expect(store.list().map((device) => device.id)).toEqual(['phone-1'])

    const empty = new PushDeviceRegistry(join(store.statePath, '..', 'absent.json'))
    await expect(empty.load()).resolves.toBeUndefined()
    expect(empty.list()).toEqual([])
  })

  it('honours COMMANDO_PUSH_DEVICES_PATH for the default location', () => {
    const previous = process.env.COMMANDO_PUSH_DEVICES_PATH
    process.env.COMMANDO_PUSH_DEVICES_PATH = '/tmp/commando-test-push-devices.json'
    try {
      expect(defaultPushDevicesPath()).toBe('/tmp/commando-test-push-devices.json')
    } finally {
      if (previous === undefined) delete process.env.COMMANDO_PUSH_DEVICES_PATH
      else process.env.COMMANDO_PUSH_DEVICES_PATH = previous
    }
    expect(defaultPushDevicesPath()).toMatch(/\.commando\/push-devices\.json$/)
  })
})
