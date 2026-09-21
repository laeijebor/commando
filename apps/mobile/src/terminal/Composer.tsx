import { useState } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native'

import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'

/**
 * The composer from mockup 03. In its default mode a message is one `paste`
 * followed by Enter, so a multi-line prompt reaches Claude Code whole; "raw"
 * turns the field into a keyboard for TUIs, sending every keystroke as it is
 * typed.
 */
export function Composer({
  raw,
  onToggleRaw,
  onSend,
  onRawText,
  onRawBackspace,
  disabled,
  notice,
}: {
  raw: boolean
  onToggleRaw: (next: boolean) => void
  onSend: (text: string) => void
  onRawText: (text: string) => void
  onRawBackspace: () => void
  disabled?: boolean
  notice?: string | null
}): React.JSX.Element {
  const theme = useTheme()
  const [text, setText] = useState('')

  const submit = (): void => {
    if (raw) {
      onSend('\n')
      return
    }
    if (text.trim().length === 0) return
    onSend(text)
    setText('')
  }

  const handleChange = (next: string): void => {
    if (!raw) {
      setText(next)
      return
    }
    // Raw mode keeps the field empty, so whatever arrives here is exactly what
    // was just typed and can go straight to the pane.
    if (next.length > 0) onRawText(next)
  }

  const handleKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    if (!raw) return
    if (event.nativeEvent.key === 'Backspace') onRawBackspace()
  }

  return (
    <View style={styles.wrap}>
      {notice ? (
        <Text style={[styles.notice, { color: theme.amber }]} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Pressable
          accessibilityLabel="Send keystrokes as they are typed"
          accessibilityRole="switch"
          accessibilityState={{ checked: raw }}
          onPress={() => onToggleRaw(!raw)}
          style={[
            styles.rawToggle,
            {
              backgroundColor: raw ? withAlpha(theme.accent, 0.2) : theme.surfaceSoft,
              borderColor: raw ? withAlpha(theme.accent, 0.4) : theme.borderMid,
            },
          ]}
        >
          <Text style={[styles.rawLabel, { color: raw ? theme.accent : theme.muted }]}>raw</Text>
        </Pressable>
        <TextInput
          accessibilityLabel={raw ? 'Raw keystrokes' : 'Message the agent'}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          multiline={!raw}
          onChangeText={handleChange}
          onKeyPress={handleKeyPress}
          placeholder={raw ? 'Keys go straight to the pane…' : 'Message the agent…'}
          placeholderTextColor={theme.textDim}
          style={[
            styles.field,
            {
              backgroundColor: theme.surfaceRaised,
              borderColor: theme.border,
              color: theme.text,
            },
          ]}
          value={raw ? '' : text}
        />
        <Pressable
          accessibilityLabel={raw ? 'Send Enter' : 'Send message'}
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(disabled) }}
          disabled={disabled}
          onPress={submit}
          style={[
            styles.send,
            { backgroundColor: theme.accent, opacity: disabled ? 0.4 : 1 },
          ]}
        >
          <Text style={[styles.sendGlyph, { color: theme.accentInk }]}>↑</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 6, gap: 4 },
  notice: { fontSize: 12, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  rawToggle: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rawLabel: { fontSize: 12.5, fontWeight: '700', fontFamily: 'Menlo' },
  field: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 38,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlyph: { fontSize: 18, fontWeight: '800' },
})
