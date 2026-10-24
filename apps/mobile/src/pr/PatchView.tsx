import { memo, useMemo, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useTheme, type Theme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { parsePatch, PATCH_CHUNK, type PatchLine } from './diff'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'
const LINE_HEIGHT = 18

/**
 * A unified patch: the old/new line numbers stay put on the left while the
 * code scrolls sideways, so long lines keep their shape. Lines draw in chunks
 * of `PATCH_CHUNK`; a generated file grows only as far as the owner asks.
 */
export const PatchView = memo(function PatchView({ patch, numbers = true, chunk = PATCH_CHUNK }: { patch: string; numbers?: boolean; chunk?: number }) {
  const theme = useTheme()
  // Without line numbers this is an excerpt (a thread's code context), which may have lost its hunk header.
  const lines = useMemo(() => parsePatch(patch, { headerless: !numbers && !patch.startsWith('@@') }), [patch, numbers])
  const [shown, setShown] = useState(chunk)
  const visible = lines.length > shown ? lines.slice(0, shown) : lines
  const width = String(lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0)).length
  const left = lines.length - visible.length
  return (
    <View style={[styles.frame, { backgroundColor: theme.terminalBg, borderColor: theme.border }]}>
      <View style={styles.row}>
        {numbers ? (
          <View style={[styles.gutter, { borderRightColor: theme.border }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {visible.map((line, index) => (
              <Text key={index} numberOfLines={1} style={[styles.number, { color: theme.textFaint, backgroundColor: lineBackground(theme, line) }]}>
                {`${pad(line.oldLine, width)}\u00a0${pad(line.newLine, width)}`}
              </Text>
            ))}
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.codeScroll} accessibilityLabel="Diff lines">
          <View style={styles.code}>
            {visible.map((line, index) => (
              <Text key={index} numberOfLines={1} selectable style={[styles.line, { color: lineColor(theme, line), backgroundColor: lineBackground(theme, line) }]}>
                {line.text || ' '}
              </Text>
            ))}
          </View>
        </ScrollView>
      </View>
      {left > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setShown((count) => count + chunk)} style={[styles.more, { borderTopColor: theme.border }]}>
          <Text style={[styles.moreLabel, { color: theme.accent }]}>Show {Math.min(chunk, left)} more lines · {left} left</Text>
        </Pressable>
      ) : null}
    </View>
  )
})

/** Non-breaking spaces, because iOS drops trailing plain spaces from right-aligned text. */
function pad(value: number | null, width: number): string {
  return (value === null ? '' : String(value)).padStart(width, '\u00a0')
}

function lineColor(theme: Theme, line: PatchLine): string {
  switch (line.kind) {
    case 'add': return theme.green
    case 'del': return theme.red
    case 'hunk': return theme.cyan
    case 'note': return theme.muted
    default: return theme.textSoft
  }
}

function lineBackground(theme: Theme, line: PatchLine): string {
  switch (line.kind) {
    case 'add': return withAlpha(theme.green, 0.1)
    case 'del': return withAlpha(theme.red, 0.1)
    case 'hunk': return withAlpha(theme.cyan, 0.07)
    default: return 'transparent'
  }
}

const styles = StyleSheet.create({
  frame: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  row: { flexDirection: 'row' },
  gutter: { borderRightWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  number: { fontFamily: MONO, fontSize: 11, lineHeight: LINE_HEIGHT, height: LINE_HEIGHT, paddingHorizontal: 6, textAlign: 'right' },
  codeScroll: { flexGrow: 1 },
  code: { paddingVertical: 6, flexGrow: 1 },
  line: { fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT, height: LINE_HEIGHT, paddingHorizontal: 8 },
  more: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10, alignItems: 'center' },
  moreLabel: { fontSize: 13, fontWeight: '600' },
})
