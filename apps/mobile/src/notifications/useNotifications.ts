import { useCallback, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'expo-router'
import * as Haptics from 'expo-haptics'
import * as Notifications from 'expo-notifications'

import { answerOverHttp } from '../answers'
import { useDaemonStore } from '../daemon/store'
import { useHostsStore } from '../hosts/store'
import {
  answerForAction,
  notificationRoute,
  parseNotificationData,
  resolveNotificationHostId,
  type PushNotificationData,
} from './routing'
import { usePushStore } from './store'

/**
 * Foreground presentation: iOS hides a notification while the app is open
 * unless the handler says otherwise, and the spec asks for an in-app banner
 * plus a haptic.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  })
}

configureNotificationHandler()

/** Registered hosts whose snapshot currently holds the notification's pane. */
function hostIdsWithPane(paneId: string): string[] {
  const byHost = useDaemonStore.getState().byHost
  return Object.entries(byHost)
    .filter(([, state]) => (
      state.agentStatuses[paneId] !== undefined ||
      state.snapshot?.panes.some((pane) => pane.id === paneId) === true
    ))
    .map(([hostId]) => hostId)
}

/**
 * Installs the response listener, replays the cold-start response, deep-links
 * by the notification's `data`, and answers the permission category's
 * background actions over the HTTP route without opening a screen.
 */
export function useNotificationRouting(): void {
  const router = useRouter()
  const pathname = usePathname()
  const currentHostId = useRef<string | undefined>(undefined)
  const handled = useRef(new Set<string>())

  useEffect(() => {
    const match = /^\/\(host\)\/([^/]+)|^\/([^/]+)\/(?:sessions|pane|answer|tiles|activity|settings)/.exec(pathname ?? '')
    const hostId = match?.[1] ?? match?.[2]
    if (hostId) currentHostId.current = decodeURIComponent(hostId)
  }, [pathname])

  const handle = useCallback(async (response: Notifications.NotificationResponse): Promise<void> => {
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`
    if (handled.current.has(key)) return
    handled.current.add(key)

    const data = parseNotificationData(response.notification.request.content.data)
    if (!data) return

    const hostId = resolveNotificationHostId({
      registeredHostIds: usePushStore.getState().registeredHostIds(),
      hostIdsWithPane: hostIdsWithPane(data.paneId),
      ...(currentHostId.current ? { currentHostId: currentHostId.current } : {}),
    })

    const answer = answerForAction(response.actionIdentifier)
    if (answer && data.interactionId) {
      await answerFromNotification(hostId, data, answer)
      return
    }

    const route = notificationRoute(data, hostId, response.actionIdentifier)
    if (route) router.push(route)
  }, [router])

  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener(() => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
    })
    const responded = Notifications.addNotificationResponseReceivedListener((response) => {
      void handle(response)
    })
    // A notification tapped while the app was not running is only available
    // through this call; the listener never sees it.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) void handle(response)
      })
      .catch(() => undefined)
    return () => {
      received.remove()
      responded.remove()
    }
  }, [handle])
}

async function answerFromNotification(
  hostId: string | undefined,
  data: PushNotificationData,
  answer: Parameters<typeof answerOverHttp>[3],
): Promise<void> {
  const host = useHostsStore.getState().hosts.find((candidate) => candidate.id === hostId)
  if (!host || !data.interactionId) return
  // The daemon's idempotency keys are `[A-Za-z0-9._:-]{1,128}`, and the same
  // action delivered twice must not answer twice.
  const key = `push-${data.interactionId}-${answer.action}`
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 128)
  await answerOverHttp(host, data.paneId, data.interactionId, answer, key)
}

/**
 * Keeps the daemon's device registry in step: the token is fetched once the
 * permission is already granted, and every host is (re-)registered whenever
 * the host list or the rules change.
 */
export function usePushRegistration(): void {
  const hosts = useHostsStore((state) => state.hosts)
  const hydrated = usePushStore((state) => state.hydrated)
  const permission = usePushStore((state) => state.permission)
  const token = usePushStore((state) => state.token)

  useEffect(() => {
    if (!hydrated) void usePushStore.getState().hydrate()
  }, [hydrated])

  useEffect(() => {
    // Asking for the permission itself is the Settings screen's job; a launch
    // only refreshes a token the user already agreed to.
    if (!hydrated || permission !== 'granted' || token.kind === 'token') return
    void usePushStore.getState().enable()
  }, [hydrated, permission, token.kind])

  useEffect(() => {
    if (token.kind !== 'token' || hosts.length === 0) return
    void usePushStore.getState().registerAll(hosts)
  }, [hosts, token])
}
