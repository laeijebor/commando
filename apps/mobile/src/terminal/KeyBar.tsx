import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'

import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { KEY_BAR_ITEMS, type KeyBarItem } from './keyBarItems'

/**
 * The scrolling key bar from mockup 03. Every button is a `key` message except
 * the slash, which is literal input, and paste, which reads the clipboard.
 */
export function KeyBar({
  onPress,
  disabled,
}: {
  onPress: (item: KeyBarItem) => void
  disabled?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
    >
      {KEY_BAR_ITEMS.map((item) => {
        const highlighted = item.action.kind !== 'key'
        return (
          <Pressable
            accessibilityLabel={item.accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ disabled: Boolean(disabled) }}
            disabled={disabled}
            key={item.id}
            onPress={() => onPress(item)}
            style={[
              styles.key,
              item.wide ? styles.wide : null,
              {
                backgroundColor: highlighted ? withAlpha(theme.accent, 0.2) : theme.surfaceSoft,
                borderColor: highlighted ? withAlpha(theme.accent, 0.4) : theme.borderMid,
                opacity: disabled ? 0.4 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.label,
                { color: highlighted ? theme.accent : theme.textSoft },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0, flexShrink: 0 },
  content: { gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  key: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wide: { paddingHorizontal: 14 },
  label: { fontSize: 13, fontWeight: '600', fontFamily: 'Menlo' },
})
