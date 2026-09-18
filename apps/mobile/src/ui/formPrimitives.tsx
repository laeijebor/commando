import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { useTheme } from '../theme'

/**
 * The grouped rows screen 07 is drawn with: a hairline-separated block where
 * each row is a label on the left and a value, a field or a switch on the
 * right.
 */
export function RowGroup({ children }: { children: ReactNode }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.group, { backgroundColor: theme.border, borderColor: theme.border }]}>
      {children}
    </View>
  )
}

function RowShell({ children }: { children: ReactNode }): React.JSX.Element {
  const theme = useTheme()
  return <View style={[styles.row, { backgroundColor: theme.surface }]}>{children}</View>
}

export function TextRow({
  label,
  value,
  onChangeText,
  placeholder,
  mono,
  multiline,
  autoCapitalize = 'none',
}: {
  label: string
  value: string
  onChangeText: (next: string) => void
  placeholder?: string
  mono?: boolean
  multiline?: boolean
  autoCapitalize?: 'none' | 'sentences'
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <RowShell>
      <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textDim}
        style={[
          styles.input,
          mono ? styles.mono : null,
          multiline ? styles.multiline : null,
          { color: theme.text },
        ]}
        value={value}
      />
    </RowShell>
  )
}

export function ValueRow({
  label,
  value,
  hint,
  onPress,
}: {
  label: string
  value: string
  hint?: string
  onPress?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const body = (
    <RowShell>
      <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
      <View style={styles.valueText}>
        <Text numberOfLines={1} style={[styles.value, { color: theme.text }]}>{value}</Text>
        {hint ? (
          <Text numberOfLines={1} style={[styles.hint, { color: theme.muted }]}>{hint}</Text>
        ) : null}
      </View>
      {onPress ? <Feather color={theme.textFaint} name="chevron-right" size={16} /> : null}
    </RowShell>
  )
  if (!onPress) return body
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      {body}
    </Pressable>
  )
}

/**
 * A switch drawn by hand rather than RN's `Switch`, so it carries the mockup's
 * green track and works the same in every theme.
 */
export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
    >
      <RowShell>
        <View style={styles.toggleText}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>{label}</Text>
          {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
        </View>
        <View style={[styles.track, { backgroundColor: value ? theme.green : theme.borderMid }]}>
          <View style={[styles.knob, value ? styles.knobOn : null]} />
        </View>
      </RowShell>
    </Pressable>
  )
}

export function FormError({ message }: { message: string }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.error, { backgroundColor: theme.surfaceRaised, borderColor: theme.red }]}>
      <Feather color={theme.red} name="alert-circle" size={15} />
      <Text style={[styles.errorText, { color: theme.red }]}>{message}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  group: { borderRadius: 14, borderWidth: 1, overflow: 'hidden', gap: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    minHeight: 46,
  },
  label: { fontSize: 13, fontWeight: '600', minWidth: 88 },
  input: { flex: 1, fontSize: 15, paddingVertical: 2, textAlign: 'right' },
  multiline: { textAlign: 'left', minHeight: 72, textAlignVertical: 'top' },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12.5 },
  valueText: { flex: 1, alignItems: 'flex-end' },
  value: { fontSize: 14.5 },
  hint: { fontSize: 12 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 14.5 },
  track: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: 'center' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#ffffff' },
  knobOn: { alignSelf: 'flex-end' },
  error: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', borderWidth: 1, borderRadius: 12, padding: 10 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
})
