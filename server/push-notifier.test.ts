import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentInteractionRequest, AgentStatus, AgentStatusKind } from '../shared/protocol.js'
import type { ExpoPushMessage } from './expo-push.js'
import type { PushDevice, PushDeviceRules } from './push-devices.js'
import {
  PushNotifier,
  deviceAcceptsNotification,
  isWithinQuietHours,
  buildNotification,
} from './push-notifier.js'

function device(overrides: Partial<PushDevice> = {}, rules: Partial<PushDeviceRules> = {}): PushDevice {
  return {
    id: 'phone-1',
    expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
    name: 'iPhone',
    platform: 'ios',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
    rules: { needsInput: true, done: true, failed: true, mutedSessions: [], ...rules },
  }
}

function status(
  kind: AgentStatusKind,
  overrides: Partial<AgentStatus> = {},
  requests: AgentInteractionRequest[] = [],
): AgentStatus {
  return {
    paneId: '%1',
    provider: 'claude',
    status: kind,
    summary: 'Summary text',
    source: 'hook',
    confidence: 'high',
    reason: 'test',
    updatedAt: 5_000,
    ...overrides,
    details: {
      recentActivities: [],
      checks: [],
      ...(requests.length ? { requests } : {}),
      ...overrides.details,
    },
  }
}

function question(id: string, createdAt = 4_000): AgentInteractionRequest {
  return {
    id,
    kind: 'question',
    prompt: 'Claude has a question',
    questions: [
      { header: 'Branch', question: 'Which branch should I target?', options: [], multiple: false, custom: true },
      { header: 'Later', question: 'Ignored second question', options: [], multiple: false, custom: true },
    ],
    createdAt,
  }
}

function harness(devices: PushDevice[] = [device()], options: { now?: () => number } = {}) {
  const send = vi.fn().mockResolvedValue({ accepted: 1, rejected: 0, unregisteredTokens: [] })
  const notifier = new PushNotifier({
    registry: { list: () => devices.map((entry) => entry) },
    sender: { send },
    paneContext: (paneId) => paneId === '%1' ? { sessionId: '$3', sessionName: 'island' } : null,
    now: options.now ?? (() => 1_700_000_000_000),
    debounceMs: 1_000,
  })
  return { notifier, send, messages: () => send.mock.calls.flatMap((call) => call[0] as ExpoPushMessage[]) }
}

const notifiers: PushNotifier[] = []

afterEach(() => {
  for (const notifier of notifiers.splice(0)) notifier.close()
  vi.useRealTimers()
})

describe('push notification building', () => {
  it('describes a question with the newest request and the first question', () => {
    const notification = buildNotification(
      status('needs_input', {}, [question('req-old', 1_000), question('req-new', 9_000)]),
      'working',
      { sessionId: '$3', sessionName: 'island' },
    )
    expect(notification).toMatchObject({
      kind: 'needs_input',
      categoryId: 'needs_input',
      title: 'Claude needs input · island',
      body: 'Which branch should I target?',
      data: {
        paneId: '%1',
        sessionId: '$3',
        sessionName: 'island',
        provider: 'claude',
        kind: 'needs_input',
        requestId: 'req-new',
        requestKind: 'question',
        interactionId: 'req-new',
      },
    })
  })

  it('describes a permission with its tool name and the permission category', () => {
    const notification = buildNotification(
      status('needs_input', { provider: 'codex' }, [{
        id: 'req-perm',
        kind: 'permission',
        prompt: 'Run rm -rf build',
        toolName: 'Bash',
        createdAt: 4_000,
      }]),
      'working',
      { sessionId: '$3', sessionName: 'island' },
    )
    expect(notification).toMatchObject({
      categoryId: 'permission',
      title: 'Codex needs input · island',
      body: 'Bash · Run rm -rf build',
      data: { requestKind: 'permission', interactionId: 'req-perm' },
    })
  })

  it('prefers the recap summary for done and reports failures', () => {
    const done = buildNotification(
      status('done', {
        provider: 'opencode',
        details: {
          recentActivities: [],
          checks: [],
          recap: { outcome: 'done', summary: 'Merged the push branch', completedAt: 8_000 },
        },
      }),
      'working',
      { sessionId: '$3', sessionName: 'island' },
    )
    expect(done).toMatchObject({
      categoryId: 'done',
      title: 'OpenCode finished · island',
      body: 'Merged the push branch',
      dedupeKey: 'done:%1:8000',
    })
    expect(buildNotification(status('done'), 'working', { sessionId: '$3', sessionName: 'island' }))
      .toMatchObject({ body: 'Summary text', dedupeKey: 'done:%1:5000' })
    expect(buildNotification(
      status('failed', { details: { recentActivities: [], checks: [], attention: 'Tests are red' } }),
      'working',
      { sessionId: '$3', sessionName: 'island' },
    )).toMatchObject({ categoryId: 'failed', title: 'Claude failed · island', body: 'Tests are red' })
  })

  it('ignores heuristic completions and failures', () => {
    const context = { sessionId: '$3', sessionName: 'island' }
    expect(buildNotification(status('done', { source: 'heuristic' }), 'working', context)).toBeNull()
    expect(buildNotification(status('failed', { source: 'process' }), 'working', context)).toBeNull()
  })

  it('ignores working and repeat terminal statuses', () => {
    const context = { sessionId: '$3', sessionName: 'island' }
    expect(buildNotification(status('working'), 'needs_input', context)).toBeNull()
    expect(buildNotification(status('needs_input'), 'working', context)).toBeNull()
    expect(buildNotification(status('done'), 'done', context)).toBeNull()
    expect(buildNotification(status('failed'), 'failed', context)).toBeNull()
  })
})

describe('push rule evaluation', () => {
  const notification = buildNotification(
    status('needs_input', {}, [question('req-1')]),
    'working',
    { sessionId: '$3', sessionName: 'island' },
  )!

  it('honours the per-kind toggles and muted sessions', () => {
    expect(deviceAcceptsNotification(device(), notification, 0)).toBe(true)
    expect(deviceAcceptsNotification(device({}, { needsInput: false }), notification, 0)).toBe(false)
    expect(deviceAcceptsNotification(device({}, { mutedSessions: ['island'] }), notification, 0)).toBe(false)
    expect(deviceAcceptsNotification(device({}, { mutedSessions: ['other'] }), notification, 0)).toBe(true)
  })

  it('silences a quiet-hour window that crosses midnight, in the device time zone', () => {
    const quietHours = { start: '23:00', end: '07:00', timeZone: 'Europe/Berlin' }
    // 2026-01-15T22:30Z is 23:30 in Berlin (UTC+1) and 17:30 in New York.
    const night = Date.parse('2026-01-15T22:30:00Z')
    // 2026-01-15T12:00Z is 13:00 in Berlin.
    const midday = Date.parse('2026-01-15T12:00:00Z')

    expect(isWithinQuietHours(quietHours, night)).toBe(true)
    expect(isWithinQuietHours(quietHours, midday)).toBe(false)
    expect(isWithinQuietHours({ ...quietHours, timeZone: 'America/New_York' }, night)).toBe(false)
    expect(isWithinQuietHours({ ...quietHours, timeZone: 'America/New_York' }, Date.parse('2026-01-16T05:30:00Z')))
      .toBe(true)
    expect(deviceAcceptsNotification(device({}, { quietHours }), notification, night)).toBe(false)
    expect(deviceAcceptsNotification(device({}, { quietHours }), notification, midday)).toBe(true)
  })

  it('handles same-day windows and an empty window', () => {
    const lunch = { start: '12:00', end: '13:00', timeZone: 'UTC' }
    expect(isWithinQuietHours(lunch, Date.parse('2026-01-15T12:00:00Z'))).toBe(true)
    expect(isWithinQuietHours(lunch, Date.parse('2026-01-15T13:00:00Z'))).toBe(false)
    expect(isWithinQuietHours(lunch, Date.parse('2026-01-15T11:59:00Z'))).toBe(false)
    expect(isWithinQuietHours({ start: '09:00', end: '09:00', timeZone: 'UTC' }, Date.parse('2026-01-15T09:30:00Z')))
      .toBe(false)
  })
})

describe('push notifier', () => {
  it('sends once per request id and again for a new request', async () => {
    const { notifier, send, messages } = harness()
    notifiers.push(notifier)

    notifier.handleStatusChange({ type: 'upsert', status: status('working') })
    await notifier.flush()
    notifier.handleStatusChange({ type: 'upsert', status: status('needs_input', {}, [question('req-1')]) })
    await notifier.flush()
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('needs_input', { updatedAt: 6_000 }, [question('req-1')]),
    })
    await notifier.flush()
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('needs_input', { updatedAt: 7_000 }, [question('req-1'), question('req-2', 7_000)]),
    })
    await notifier.flush()

    expect(send).toHaveBeenCalledTimes(2)
    expect(messages().map((message) => message.data.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('sends one completion per recap and skips repeats', async () => {
    const recap = { outcome: 'done' as const, summary: 'Shipped', completedAt: 8_000 }
    const { notifier, send } = harness()
    notifiers.push(notifier)

    notifier.handleStatusChange({ type: 'upsert', status: status('working') })
    await notifier.flush()
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('done', { details: { recentActivities: [], checks: [], recap } }),
    })
    await notifier.flush()
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('done', { updatedAt: 9_000, details: { recentActivities: [], checks: [], recap } }),
    })
    await notifier.flush()
    notifier.handleStatusChange({ type: 'upsert', status: status('working', { updatedAt: 10_000 }) })
    await notifier.flush()
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('done', { updatedAt: 11_000, details: { recentActivities: [], checks: [], recap } }),
    })
    await notifier.flush()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst on the same pane to the latest status after the debounce window', async () => {
    vi.useFakeTimers()
    const { notifier, send, messages } = harness()
    notifiers.push(notifier)

    notifier.handleStatusChange({ type: 'upsert', status: status('needs_input', {}, [question('req-1')]) })
    notifier.handleStatusChange({ type: 'upsert', status: status('working', { updatedAt: 5_500 }) })
    notifier.handleStatusChange({
      type: 'upsert',
      status: status('failed', { updatedAt: 5_900, summary: 'Build broke' }),
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await notifier.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ title: 'Claude failed · island', body: 'Build broke' })
  })

  it('only messages devices whose rules accept the notification', async () => {
    const devices = [
      device({ id: 'phone-1' }),
      device({ id: 'phone-2', expoPushToken: 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]' }, { needsInput: false }),
      device({
        id: 'tablet',
        expoPushToken: 'ExpoPushToken[cccccccccccccccccccccc]',
        platform: 'android',
      }, { mutedSessions: ['island'] }),
    ]
    const { notifier, messages } = harness(devices)
    notifiers.push(notifier)

    notifier.handleStatusChange({ type: 'upsert', status: status('needs_input', {}, [question('req-1')]) })
    await notifier.flush()

    expect(messages().map((message) => message.to)).toEqual(['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'])
  })

  it('adds an Android channel id and skips panes without a session', async () => {
    const android = device({
      id: 'pixel',
      platform: 'android',
      expoPushToken: 'ExpoPushToken[dddddddddddddddddddddd]',
    })
    const { notifier, send, messages } = harness([android])
    notifiers.push(notifier)

    notifier.handleStatusChange({
      type: 'upsert',
      status: status('needs_input', { paneId: '%9' }, [question('req-9')]),
    })
    await notifier.flush()
    expect(send).not.toHaveBeenCalled()

    notifier.handleStatusChange({ type: 'upsert', status: status('needs_input', {}, [question('req-1')]) })
    await notifier.flush()
    expect(messages()[0].channelId).toBe('agent-events')
  })

  it('drops a pending burst when the pane disappears and survives sender failures', async () => {
    const send = vi.fn().mockRejectedValue(new Error('expo unreachable'))
    const warn = vi.fn()
    const notifier = new PushNotifier({
      registry: { list: () => [device()] },
      sender: { send },
      paneContext: () => ({ sessionId: '$3', sessionName: 'island' }),
      debounceMs: 1_000,
      logger: { warn },
    })
    notifiers.push(notifier)

    notifier.handleStatusChange({ type: 'upsert', status: status('needs_input', {}, [question('req-1')]) })
    notifier.handleStatusChange({ type: 'remove', paneId: '%1' })
    await notifier.flush()
    expect(send).not.toHaveBeenCalled()

    notifier.handleStatusChange({ type: 'upsert', status: status('failed') })
    await notifier.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('sends a test notification regardless of the device rules', async () => {
    const { notifier, messages } = harness([device({}, { needsInput: false, done: false, failed: false })])
    notifiers.push(notifier)

    await notifier.sendTest(device({}, { needsInput: false, done: false, failed: false }))

    expect(messages()[0]).toMatchObject({ categoryId: 'test', data: { kind: 'test', deviceId: 'phone-1' } })
  })
})
