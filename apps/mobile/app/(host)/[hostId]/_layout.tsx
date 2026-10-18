import { Tabs, BottomTabBar, type BottomTabBarProps } from 'expo-router/js-tabs'
import { isHostTab, visibleHostTabs } from '../../../src/layout/hostTabs'
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
      tabBar={(props: BottomTabBarProps) => isHostTab(props.state.routes[props.state.index]?.name ?? '') ? <BottomTabBar {...props} state={visibleHostTabs(props.state)} /> : null}
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
          title: 'Chats',
          tabBarIcon: ({ color, size }) => <Feather color={color} name="message-circle" size={size} />,
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
      <Tabs.Screen name="new-window" options={{ href: null }} />
      <Tabs.Screen name="new-pane" options={{ href: null }} />
      <Tabs.Screen name="pane/[paneId]" options={{ href: null }} />
      <Tabs.Screen name="pane/[paneId]/info" options={{ href: null }} />
      <Tabs.Screen name="tile/[tileId]" options={{ href: null }} />
      <Tabs.Screen name="answer/[paneId]/[interactionId]" options={{ href: null }} />
      <Tabs.Screen name="index" options={{ href: null }} />
    </Tabs>
  )
}
