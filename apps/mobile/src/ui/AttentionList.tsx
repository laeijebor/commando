import { StyleSheet, View } from 'react-native'

import type { ProviderUsage } from '@commando/protocol'

import type { AgentGroup, AgentRow } from '../agents/selectors'
import { AgentRowCard } from './AgentRowCard'
import { EmptyState, SectionHeader } from './primitives'
import { UsageTiles } from './UsageTiles'

/**
 * The attention half of screen 02: usage tiles, then the Needs you / Working /
 * Done / Idle groups. Kept separate from the route so it can be rendered in a
 * test without a router or a socket.
 */
export function AttentionList({
  groups,
  usage,
  onSelectRow,
}: {
  groups: readonly AgentGroup[]
  usage: readonly ProviderUsage[]
  onSelectRow?: (row: AgentRow) => void
}): React.JSX.Element {
  return (
    <View style={styles.container}>
      <UsageTiles usage={usage} />
      {groups.map((group) => (
        <View key={group.id} style={styles.group}>
          <SectionHeader label={group.label} note={String(group.rows.length)} />
          <View style={styles.list}>
            {group.rows.map((row) => (
              <AgentRowCard key={row.paneId} onPress={() => onSelectRow?.(row)} row={row} />
            ))}
          </View>
        </View>
      ))}
      {groups.length === 0 ? (
        <EmptyState
          body="Once an agent reports in, it shows up here grouped by who needs you."
          title="No agents reporting"
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  group: { gap: 8 },
  list: { gap: 8 },
})
