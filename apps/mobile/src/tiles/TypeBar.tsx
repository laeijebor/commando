import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { useTheme } from '../theme'

const KEYS = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown'] as const

/**
 * Typing into a page that is really running on the Mac. The phone's keyboard
 * hands over finished text rather than keystrokes, so the bar sends the text
 * as a per-character CDP key sequence when you commit it, and offers the
 * non-printing keys a page field still needs.
 *
 * Tap the element you want to type into first — focus lives in the page, and
 * the tap that focused it is an ordinary CDP click.
 */
export function TypeBar({
  onType,
  onKey,
  disabled,
}: {
  onType: (text: string) => void
  onKey: (key: string) => void
  disabled: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const [text, setText] = useState('')

  const commit = (): void => {
    const value = text
    if (!value) return
    setText('')
    onType(value)
  }

  return (
    <View style={[styles.bar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <TextInput
        accessibilityLabel="Type into the page"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={setText}
        onSubmitEditing={commit}
        placeholder="Type into the focused field…"
        placeholderTextColor={theme.textDim}
        returnKeyType="send"
        style={[styles.input, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text }]}
        value={text}
      />
      <View style={styles.keys}>
        {KEYS.map((key) => (
          <Pressable
            accessibilityLabel={`Send ${key}`}
            accessibilityRole="button"
            disabled={disabled}
            key={key}
            onPress={() => onKey(key)}
            style={[styles.key, { backgroundColor: theme.surfaceSoft, borderColor: theme.borderMid }]}
          >
            <Text style={[styles.keyLabel, { color: theme.textSoft }]}>{keyLabel(key)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

function keyLabel(key: string): string {
  switch (key) {
    case 'Enter':
      return '⏎'
    case 'Tab':
      return '⇥'
    case 'Backspace':
      return '⌫'
    case 'Escape':
      return 'esc'
    case 'ArrowUp':
      return '↑'
    case 'ArrowDown':
      return '↓'
    default:
      return key
  }
}

const styles = StyleSheet.create({
  bar: { borderWidth: 1, borderRadius: 12, padding: 8, gap: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14 },
  keys: { flexDirection: 'row', gap: 6 },
  key: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLabel: { fontSize: 13, fontWeight: '600' },
})
