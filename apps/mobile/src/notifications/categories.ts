import * as Notifications from 'expo-notifications'

import { PUSH_ACTIONS, PUSH_CATEGORIES } from './routing'

type CategoryDefinition = {
  identifier: string
  actions: Notifications.NotificationAction[]
}

/**
 * The lock-screen actions from mockup 08. "Allow once" and "Deny" stay in the
 * background (`opensAppToForeground: false`) and answer over the HTTP route, so
 * the simple permission cases never open the app; everything else opens a
 * screen.
 */
export const PUSH_CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    identifier: PUSH_CATEGORIES.needsInput,
    actions: [
      { identifier: PUSH_ACTIONS.answer, buttonTitle: 'Answer', options: { opensAppToForeground: true } },
      { identifier: PUSH_ACTIONS.openPane, buttonTitle: 'Open pane', options: { opensAppToForeground: true } },
    ],
  },
  {
    identifier: PUSH_CATEGORIES.permission,
    actions: [
      {
        identifier: PUSH_ACTIONS.allowOnce,
        buttonTitle: 'Allow once',
        options: { opensAppToForeground: false },
      },
      {
        identifier: PUSH_ACTIONS.deny,
        buttonTitle: 'Deny',
        options: { opensAppToForeground: false, isDestructive: true },
      },
      { identifier: PUSH_ACTIONS.openPane, buttonTitle: 'Open', options: { opensAppToForeground: true } },
    ],
  },
  // done / failed carry no buttons: tapping opens the pane.
  { identifier: PUSH_CATEGORIES.done, actions: [] },
  { identifier: PUSH_CATEGORIES.failed, actions: [] },
]

/** Registered once per launch; iOS keeps the definitions until they change. */
export async function registerNotificationCategories(): Promise<void> {
  for (const category of PUSH_CATEGORY_DEFINITIONS) {
    try {
      await Notifications.setNotificationCategoryAsync(category.identifier, category.actions)
    } catch {
      // A simulator without notification support must not stop the launch.
    }
  }
}
