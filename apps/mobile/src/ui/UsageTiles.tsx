import { StyleSheet, Text, View } from 'react-native'

import type { ProviderUsage } from '@commando/protocol'

import { useTheme } from '../theme'
import { Card, ProgressBar, type DotTone } from './primitives'

function resetLabel(resetsAt: number | undefined): string {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  const withinDay = resetsAt - Date.now() < 24 * 60 * 60 * 1000
  if (withinDay) {
    return ` · resets ${date.getHours().toString().padStart(2, '0')}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}`
  }
  return ` · resets ${date.toLocaleDateString(undefined, { weekday: 'short' })}`
}

function providerTitle(provider: ProviderUsage['provider']): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

function providerTone(provider: ProviderUsage['provider']): DotTone {
  return provider === 'claude' ? 'green' : 'cyan'
}

/**
 * The usage strip at the top of the attention view. A provider whose usage the
 * daemon cannot read is left out entirely rather than shown as an empty tile.
 */
export function UsageTiles({ usage }: { usage: readonly ProviderUsage[] }): React.JSX.Element | null {
  const theme = useTheme()
  const available = usage.filter((entry) => entry.state === 'available' && entry.windows.length > 0)
  if (available.length === 0) return null

  return (
    <View style={styles.row}>
      {available.map((entry) => {
        const window = entry.windows[0]
        if (!window) return null
        const tone = providerTone(entry.provider)
        const color = tone === 'green' ? theme.green : theme.cyan
        return (
          <Card key={entry.provider} style={styles.tile}>
            <View style={styles.heading}>
              <Text style={[styles.title, { color: theme.text }]}>{providerTitle(entry.provider)}</Text>
              <Text style={[styles.remaining, { color }]}>
                {Math.round(window.remainingPercent)}% left
              </Text>
            </View>
            <ProgressBar ratio={window.usedPercent / 100} tone={tone} />
            <Text style={[styles.detail, { color: theme.muted }]}>
              {window.label}
              {resetLabel(window.resetsAt)}
            </Text>
          </Card>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, gap: 6 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  title: { fontSize: 14, fontWeight: '700' },
  remaining: { fontSize: 13, fontWeight: '700' },
  detail: { fontSize: 11 },
})
