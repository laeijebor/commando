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
        {/*
          `title` is what the next screen's back button reads, so the hosts
          list needs one even though it draws its own header.
        */}
        <Stack.Screen name="index" options={{ headerShown: false, title: 'Hosts' }} />
        {/*
          `app/(host)` holds no layout of its own, so the group adds no
          navigator level and the child route's real name is the whole path.
          Naming it `(host)` matched nothing: the screen fell back to the
          defaults and drew `(host)/[hostId]` as its title.

          The host's own tabs carry the titles, and nothing inside them leads
          back to the hosts list, so this header stays for its back button and
          only drops the redundant title.
        */}
        <Stack.Screen name="(host)/[hostId]" options={{ title: '' }} />
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
