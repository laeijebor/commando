import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useTheme } from '../theme'

/**
 * The frame screen 07 and its lighter variants share: Cancel on the left, the
 * title in the middle, the confirming action on the right, and a scrolling
 * body that keeps clear of the keyboard.
 */
export function CreateSheet({
  title,
  subtitle,
  action,
  actionEnabled,
  busy,
  onCancel,
  onAction,
  children,
}: {
  title: string
  subtitle?: string
  action: string
  actionEnabled: boolean
  busy?: boolean
  onCancel: () => void
  onAction: () => void
  children: ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
      <View style={styles.nav}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.navSide}>
          <Text style={[styles.cancel, { color: theme.muted }]}>Cancel</Text>
        </Pressable>
        <View style={styles.navTitle}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>{title}</Text>
          {subtitle ? (
            <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>{subtitle}</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !actionEnabled || busy === true }}
          disabled={!actionEnabled || busy === true}
          onPress={onAction}
          style={[styles.navSide, styles.navAction]}
        >
          {busy ? (
            <ActivityIndicator color={theme.accent} size="small" />
          ) : (
            <Text style={[styles.action, { color: actionEnabled ? theme.accent : theme.textDim }]}>
              {action}
            </Text>
          )}
        </Pressable>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  grab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 8 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
  navSide: { minWidth: 62 },
  navAction: { alignItems: 'flex-end' },
  navTitle: { flex: 1, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 12 },
  cancel: { fontSize: 15 },
  action: { fontSize: 15, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingBottom: 48, gap: 14 },
})
