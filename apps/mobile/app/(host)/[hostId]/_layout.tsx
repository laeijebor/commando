import { Tabs } from 'expo-router'
import Feather from '@expo/vector-icons/Feather'

import { useTheme } from '../../../src/theme'

/**
 * The four-tab bar from the mockup. Pane, answer and new-session are pushed on
 * top of the tabs rather than being tabs themselves, so they are registered
 * with `href: null`.
 */
export default function HostTabsLayout(): React.JSX.Element {
  const theme = useTheme()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: theme.bg },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textDim,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color, size }) => <Feather color={color} name="terminal" size={size} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color, size }) => <Feather color={color} name="activity" size={size} />,
        }}
      />
      <Tabs.Screen
        name="tiles"
        options={{
          title: 'Tiles',
          tabBarIcon: ({ color, size }) => <Feather color={color} name="grid" size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather color={color} name="settings" size={size} />,
        }}
      />
      <Tabs.Screen name="new-session" options={{ href: null }} />
      <Tabs.Screen name="pane/[paneId]" options={{ href: null }} />
      <Tabs.Screen name="tile/[tileId]" options={{ href: null }} />
      <Tabs.Screen name="answer/[paneId]/[interactionId]" options={{ href: null }} />
      <Tabs.Screen name="index" options={{ href: null }} />
    </Tabs>
  )
}
