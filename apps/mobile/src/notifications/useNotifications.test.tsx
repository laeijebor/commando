import { act, renderHook } from '@testing-library/react-native'
import * as Haptics from 'expo-haptics'
import * as Notifications from 'expo-notifications'
import { asideKey } from '@commando/agent-chat'
import { configureNotificationHandler, useNotificationRouting } from './useNotifications'

jest.mock('expo-router', () => ({ usePathname: () => '/studio/settings', useRouter: () => ({ push: jest.fn() }) }))

const notification = (data?: Record<string, unknown>) => ({ request: { identifier: 'test-push', content: { data } } }) as Notifications.Notification

beforeEach(() => jest.clearAllMocks())

it.each([
  [{ kind: 'test' }, true],
  [undefined, true],
  [{}, true],
  [{ paneId: 7, kind: 'test' }, true],
  [{ paneId: '%7', kind: 'done' }, true],
  [{ paneId: '%7~invalid', kind: 'done' }, true],
  [{ paneId: asideKey('%7', 'aside001'), kind: 'done' }, false],
] as const)('presents and haptics foreground payload %j only when it is not an aside', async (data, show) => {
  configureNotificationHandler()
  const handler = jest.mocked(Notifications.setNotificationHandler).mock.calls.at(-1)![0]!
  await expect(handler.handleNotification(notification(data))).resolves.toMatchObject({
    shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false,
  })
  renderHook(useNotificationRouting)
  const received = jest.mocked(Notifications.addNotificationReceivedListener).mock.calls.at(-1)![0]
  await act(async () => { received(notification(data)) })
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(show ? 1 : 0)
})
