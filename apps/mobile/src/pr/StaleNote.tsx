import { StyleSheet, Text } from 'react-native'

import { useTheme } from '../theme'
import { relativeTime } from '../time'
import type { PrDetails } from './api'

/** The daemon serves its last copy while GitHub is rate limited, and says so. */
export function StaleNote({ details }: { details: PrDetails }): React.JSX.Element {
  const theme = useTheme()
  const at = details.fetchedAt ? Math.min(details.fetchedAt.metadata, details.fetchedAt.conversation) : 0
  return (
    <Text style={[styles.stale, { color: theme.amber }]}>
      GitHub is rate limiting the daemon, so this is the copy from {relativeTime(at) || 'earlier'} ago
      {details.retryAt ? `; it refreshes after ${new Date(details.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
    </Text>
  )
}

const styles = StyleSheet.create({
  stale: { fontSize: 12.5, lineHeight: 17 },
})
