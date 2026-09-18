import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { useHostsStore } from '../src/hosts/store'
import { useNotificationRouting, usePushRegistration } from '../src/notifications'
import { ThemeProvider, useTheme } from '../src/theme'

function RootStack(): React.JSX.Element {
  const theme = useTheme()
  const hydrate = useHostsStore((state) => state.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Push lives at the root so a notification can be handled whatever screen is
  // on top, including the cold start that a tapped notification causes.
  usePushRegistration()
  useNotificationRouting()

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.bg },
          headerTintColor: theme.accent,
          headerTitleStyle: { color: theme.text },
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(host)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  )
}

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootStack />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
