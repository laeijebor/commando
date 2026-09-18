import { useLocalSearchParams } from 'expo-router'
import { StyleSheet, Text } from 'react-native'

import { useDaemonConnection } from '../../../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../../../src/hosts/store'
import { useTheme } from '../../../../../src/theme'
import { Card } from '../../../../../src/ui/primitives'
import { PlaceholderScreen } from '../../../../../src/ui/Placeholder'

/**
 * Screen 04. The request is read from the agent status the daemon already
 * broadcasts; sending the answer over `answer_agent_request` is the next phase.
 */
export default function AnswerScreen(): React.JSX.Element {
  const theme = useTheme()
  const { hostId, paneId, interactionId } = useLocalSearchParams<{
    hostId: string
    paneId: string
    interactionId: string
  }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)
  const request = paneId
    ? state.agentStatuses[paneId]?.details?.requests?.find((candidate) => candidate.id === interactionId)
    : undefined
  const question = request?.questions?.[0]

  return (
    <PlaceholderScreen
      planned={[
        'Option list honouring the multiple / custom flags on AgentQuestion',
        'Permission card with Allow once, Always allow and Deny',
        'Send over answer_agent_request with a requestIdempotencyKey',
        'The same actions from a push notification, without opening the app',
      ]}
      summary={request?.prompt ?? 'This request is no longer pending.'}
      title={request?.kind === 'permission' ? 'Permission' : 'Question'}
    >
      {question ? (
        <Card raised style={styles.card}>
          <Text style={[styles.question, { color: theme.text }]}>{question.question}</Text>
          {question.options.map((option) => (
            <Text key={option.label} style={[styles.option, { color: theme.textSoft }]}>
              • {option.label}
              {option.description ? ` — ${option.description}` : ''}
            </Text>
          ))}
        </Card>
      ) : null}
    </PlaceholderScreen>
  )
}

const styles = StyleSheet.create({
  card: { gap: 6 },
  question: { fontSize: 15, fontWeight: '600' },
  option: { fontSize: 13.5, lineHeight: 19 },
})
