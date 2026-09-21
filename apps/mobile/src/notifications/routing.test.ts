import { PUSH_CATEGORY_DEFINITIONS } from './categories'
import {
  actionOpensApp,
  answerForAction,
  notificationRoute,
  parseNotificationData,
  PUSH_ACTIONS,
  PUSH_CATEGORIES,
  resolveNotificationHostId,
} from './routing'

/** The payload `server/push-notifier.ts` documents in the README. */
const NEEDS_INPUT = {
  paneId: '%12',
  sessionId: '$3',
  sessionName: 'island',
  provider: 'claude',
  kind: 'needs_input',
  requestId: 'req-1',
  requestKind: 'permission',
  interactionId: 'req-1',
}

describe('reading a push payload', () => {
  it('parses the daemon payload as it is sent', () => {
    expect(parseNotificationData(NEEDS_INPUT)).toEqual({
      paneId: '%12',
      sessionId: '$3',
      sessionName: 'island',
      provider: 'claude',
      kind: 'needs_input',
      requestId: 'req-1',
      requestKind: 'permission',
      interactionId: 'req-1',
    })
  })

  it('refuses a payload without a pane and ignores unknown kinds', () => {
    expect(parseNotificationData({ kind: 'done' })).toBeNull()
    expect(parseNotificationData(null)).toBeNull()
    expect(parseNotificationData({ paneId: '%1', kind: 'something-new' })?.kind).toBe('needs_input')
  })
})

describe('routing a notification', () => {
  it('opens the answer screen for a pending request, flagged as coming from a notification', () => {
    expect(notificationRoute(parseNotificationData(NEEDS_INPUT)!, 'host-1')).toEqual({
      pathname: '/(host)/[hostId]/answer/[paneId]/[interactionId]',
      params: { hostId: 'host-1', paneId: '%12', interactionId: 'req-1', from: 'notification' },
    })
  })

  it('opens the pane for done and failed', () => {
    const done = parseNotificationData({ paneId: '%40', kind: 'done' })!
    expect(notificationRoute(done, 'host-1')).toEqual({
      pathname: '/(host)/[hostId]/pane/[paneId]',
      params: { hostId: 'host-1', paneId: '%40' },
    })
  })

  it('honours the Open pane action even when something is pending', () => {
    expect(notificationRoute(parseNotificationData(NEEDS_INPUT)!, 'host-1', PUSH_ACTIONS.openPane))
      .toEqual({
        pathname: '/(host)/[hostId]/pane/[paneId]',
        params: { hostId: 'host-1', paneId: '%12' },
      })
  })

  it('routes nowhere without a host', () => {
    expect(notificationRoute(parseNotificationData(NEEDS_INPUT)!, undefined)).toBeNull()
  })
})

describe('notification actions', () => {
  it('maps the permission category actions onto protocol answers', () => {
    expect(answerForAction(PUSH_ACTIONS.allowOnce)).toEqual({ action: 'allow_once' })
    expect(answerForAction(PUSH_ACTIONS.deny)).toEqual({ action: 'deny' })
    expect(answerForAction(PUSH_ACTIONS.answer)).toBeNull()
    expect(answerForAction(PUSH_ACTIONS.openPane)).toBeNull()
  })

  it('answers in the background and opens the app for everything else', () => {
    expect(actionOpensApp(PUSH_ACTIONS.allowOnce)).toBe(false)
    expect(actionOpensApp(PUSH_ACTIONS.deny)).toBe(false)
    expect(actionOpensApp(PUSH_ACTIONS.answer)).toBe(true)
  })

  it('declares the four daemon categories with the mockup buttons', () => {
    const byId = Object.fromEntries(
      PUSH_CATEGORY_DEFINITIONS.map((category) => [category.identifier, category.actions]),
    )
    expect(Object.keys(byId).sort()).toEqual(
      [PUSH_CATEGORIES.done, PUSH_CATEGORIES.failed, PUSH_CATEGORIES.needsInput, PUSH_CATEGORIES.permission].sort(),
    )
    expect(byId[PUSH_CATEGORIES.needsInput]?.map((action) => action.buttonTitle))
      .toEqual(['Answer', 'Open pane'])
    expect(byId[PUSH_CATEGORIES.permission]?.map((action) => action.buttonTitle))
      .toEqual(['Allow once', 'Deny', 'Open'])
    for (const action of byId[PUSH_CATEGORIES.permission] ?? []) {
      expect(action.options?.opensAppToForeground).toBe(actionOpensApp(action.identifier))
    }
    expect(byId[PUSH_CATEGORIES.done]).toEqual([])
  })
})

describe('attributing a notification to a host', () => {
  it('prefers the registered host whose snapshot holds the pane', () => {
    expect(resolveNotificationHostId({
      registeredHostIds: ['host-1', 'host-2'],
      hostIdsWithPane: ['host-2'],
      currentHostId: 'host-1',
    })).toBe('host-2')
  })

  it('ignores a pane match on a host this install never registered', () => {
    expect(resolveNotificationHostId({
      registeredHostIds: ['host-1'],
      hostIdsWithPane: ['host-9'],
    })).toBe('host-1')
  })

  it('falls back to the current host, then to the first registration', () => {
    expect(resolveNotificationHostId({
      registeredHostIds: ['host-1', 'host-2'],
      currentHostId: 'host-2',
    })).toBe('host-2')
    expect(resolveNotificationHostId({ registeredHostIds: ['host-1', 'host-2'] })).toBe('host-1')
    expect(resolveNotificationHostId({ registeredHostIds: [], currentHostId: 'host-3' })).toBe('host-3')
    expect(resolveNotificationHostId({ registeredHostIds: [] })).toBeUndefined()
  })
})
