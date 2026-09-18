import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'

export const MAX_PUSH_DEVICES = 16
export const MAX_MUTED_SESSIONS = 64
const MAX_DEVICE_ID_LENGTH = 64
const MAX_DEVICE_NAME_LENGTH = 80
const MAX_SESSION_NAME_LENGTH = 128
const MAX_TIME_ZONE_LENGTH = 64
const MAX_EXPO_TOKEN_LENGTH = 200

const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[^[\]\s]{1,160}\]$/
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export type PushDevicePlatform = 'ios' | 'android'

export type PushQuietHours = {
  start: string
  end: string
  timeZone: string
}

export type PushDeviceRules = {
  needsInput: boolean
  done: boolean
  failed: boolean
  quietHours?: PushQuietHours
  mutedSessions: string[]
}

export type PushDevice = {
  id: string
  expoPushToken: string
  name: string
  platform: PushDevicePlatform
  rules: PushDeviceRules
  createdAt: number
  updatedAt: number
}

export type PushDeviceInput = Omit<PushDevice, 'createdAt' | 'updatedAt'>

type StateFile = {
  version: 1
  devices: PushDevice[]
}

export class PushDeviceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new PushDeviceError(400, message)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > MAX_TIME_ZONE_LENGTH || /[^A-Za-z0-9_+\-/]/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function validatePushDeviceId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DEVICE_ID_LENGTH || !DEVICE_ID.test(value)) {
    invalid('id must be 1-64 characters of A-Z, a-z, 0-9, dot, underscore or dash')
  }
  return value
}

function parseQuietHours(value: unknown): PushQuietHours | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) invalid('rules.quietHours must be an object')
  const { start, end, timeZone } = value
  if (typeof start !== 'string' || !CLOCK_TIME.test(start)) invalid('rules.quietHours.start must be HH:MM')
  if (typeof end !== 'string' || !CLOCK_TIME.test(end)) invalid('rules.quietHours.end must be HH:MM')
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) {
    invalid('rules.quietHours.timeZone must be an IANA time zone')
  }
  return { start, end, timeZone }
}

function parseMutedSessions(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('rules.mutedSessions must be an array')
  if (value.length > MAX_MUTED_SESSIONS) {
    invalid(`rules.mutedSessions accepts at most ${MAX_MUTED_SESSIONS} entries`)
  }
  const muted: string[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_SESSION_NAME_LENGTH ||
      hasControlCharacters(entry)
    ) invalid('rules.mutedSessions entries must be tmux session names')
    if (!muted.includes(entry)) muted.push(entry)
  }
  return muted
}

function parseRules(value: unknown): PushDeviceRules {
  if (!isRecord(value)) invalid('rules must be an object')
  const { needsInput, done, failed } = value
  if (typeof needsInput !== 'boolean') invalid('rules.needsInput must be a boolean')
  if (typeof done !== 'boolean') invalid('rules.done must be a boolean')
  if (typeof failed !== 'boolean') invalid('rules.failed must be a boolean')
  const quietHours = parseQuietHours(value.quietHours)
  return {
    needsInput,
    done,
    failed,
    ...(quietHours ? { quietHours } : {}),
    mutedSessions: parseMutedSessions(value.mutedSessions),
  }
}

/**
 * Validates a client-supplied device registration. The id comes from the route,
 * so a body id is optional but has to agree when it is present.
 */
export function validatePushDeviceInput(id: string, value: unknown): PushDeviceInput {
  const deviceId = validatePushDeviceId(id)
  if (!isRecord(value)) invalid('Request body must be a JSON object')
  if (value.id !== undefined && value.id !== deviceId) invalid('id does not match the route')
  const { expoPushToken, name, platform } = value
  if (
    typeof expoPushToken !== 'string' ||
    expoPushToken.length > MAX_EXPO_TOKEN_LENGTH ||
    !EXPO_PUSH_TOKEN.test(expoPushToken)
  ) invalid('expoPushToken must look like ExponentPushToken[...] or ExpoPushToken[...]')
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_DEVICE_NAME_LENGTH ||
    hasControlCharacters(name)
  ) invalid(`name must be 1-${MAX_DEVICE_NAME_LENGTH} characters`)
  if (platform !== 'ios' && platform !== 'android') invalid("platform must be 'ios' or 'android'")
  return {
    id: deviceId,
    expoPushToken,
    name: name.trim(),
    platform,
    rules: parseRules(value.rules),
  }
}

function parsePersistedDevice(value: unknown): PushDevice | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  try {
    const input = validatePushDeviceInput(value.id, value)
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0
    const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : createdAt
    return { ...input, createdAt, updatedAt }
  } catch {
    return null
  }
}

function parseState(value: unknown): PushDevice[] {
  if (!isRecord(value) || !Array.isArray(value.devices)) return []
  return value.devices
    .map(parsePersistedDevice)
    .filter((device): device is PushDevice => device !== null)
    .slice(0, MAX_PUSH_DEVICES)
}

export function defaultPushDevicesPath(): string {
  return process.env.COMMANDO_PUSH_DEVICES_PATH
    ?? join(homedir(), '.commando', 'push-devices.json')
}

function cloneDevice(device: PushDevice): PushDevice {
  return {
    ...device,
    rules: {
      ...device.rules,
      ...(device.rules.quietHours ? { quietHours: { ...device.rules.quietHours } } : {}),
      mutedSessions: [...device.rules.mutedSessions],
    },
  }
}

/**
 * Owner-registered Expo push devices, persisted as JSON with an atomic
 * write-then-rename at mode 0600 like the daemon's other secrets.
 */
export class PushDeviceRegistry {
  readonly statePath: string
  private readonly devices = new Map<string, PushDevice>()
  private writes: Promise<void> = Promise.resolve()

  constructor(statePath = defaultPushDevicesPath()) {
    this.statePath = statePath
  }

  async load(): Promise<void> {
    await this.writes
    try {
      const devices = parseState(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
      this.devices.clear()
      for (const device of devices) this.devices.set(device.id, device)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new Error('Push device state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  list(): PushDevice[] {
    return [...this.devices.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(cloneDevice)
  }

  get(id: string): PushDevice | null {
    const device = this.devices.get(id)
    return device ? cloneDevice(device) : null
  }

  async upsert(input: PushDeviceInput, now = Date.now()): Promise<PushDevice> {
    const existing = this.devices.get(input.id)
    if (!existing && this.devices.size >= MAX_PUSH_DEVICES) {
      throw new PushDeviceError(409, `At most ${MAX_PUSH_DEVICES} push devices can be registered`)
    }
    const device: PushDevice = {
      ...input,
      rules: { ...input.rules, mutedSessions: [...input.rules.mutedSessions] },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.devices.set(device.id, device)
    await this.persist()
    return cloneDevice(device)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.devices.delete(id)) return false
    await this.persist()
    return true
  }

  /** Drops every device holding an Expo token the push service rejected. */
  async removeByToken(expoPushToken: string): Promise<string[]> {
    const removed = [...this.devices.values()]
      .filter((device) => device.expoPushToken === expoPushToken)
      .map((device) => device.id)
    if (!removed.length) return []
    for (const id of removed) this.devices.delete(id)
    await this.persist()
    return removed
  }

  private persist(): Promise<void> {
    const operation = this.writes.then(() => this.writeState())
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async writeState(): Promise<void> {
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      const state: StateFile = { version: 1, devices: [...this.devices.values()] }
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.chmod(0o600)
      await handle.close()
      handle = null
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
