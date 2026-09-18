import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useRouter } from 'expo-router'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'

import { agentCounts, buildAgentRows } from '../src/agents/selectors'
import { connectHost } from '../src/daemon/client'
import { useDaemonStore } from '../src/daemon/store'
import { EMPTY_HOST_STATE } from '../src/daemon/state'
import { useHostsStore } from '../src/hosts/store'
import { hostLabel, type Host, type HostReachability } from '../src/hosts/types'
import { relativeTime } from '../src/time'
import { useTheme } from '../src/theme'
import { Button, Card, Dot, EmptyState, ScreenTitle } from '../src/ui/primitives'
import { SignInSheet } from '../src/ui/SignInSheet'

export default function HostsScreen(): React.JSX.Element {
  const theme = useTheme()
  const hosts = useHostsStore((state) => state.hosts)
  const hydrated = useHostsStore((state) => state.hydrated)
  const reachability = useHostsStore((state) => state.reachability)
  const cookies = useHostsStore((state) => state.cookies)
  const removeHost = useHostsStore((state) => state.removeHost)
  const [signInHost, setSignInHost] = useState<Host | null>(null)
  const [addVisible, setAddVisible] = useState(false)
  const [editing, setEditing] = useState(false)

  // Badge counts come from the live snapshot, so reachable hosts get a socket
  // as soon as the list appears.
  useEffect(() => {
    for (const host of hosts) {
      if (reachability[host.id]?.state === 'online') connectHost(host, cookies[host.id] ?? null)
    }
  }, [hosts, reachability, cookies])

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle
        title="Hosts"
        trailing={
          <Pressable onPress={() => setEditing((current) => !current)}>
            <Text style={[styles.action, { color: theme.accent }]}>{editing ? 'Done' : 'Edit'}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        {hosts.map((host) => (
          <HostCard
            editing={editing}
            host={host}
            key={host.id}
            onRemove={() => void removeHost(host.id)}
            onSignIn={() => setSignInHost(host)}
            reachability={reachability[host.id]}
          />
        ))}

        {hydrated && hosts.length === 0 ? (
          <EmptyState
            body="Add the daemon's Tailscale address and port, then sign in as the owner."
            title="No hosts yet"
          />
        ) : null}

        <Button label="Add host" onPress={() => setAddVisible(true)} />

        <Text style={[styles.footnote, { color: theme.textDim }]}>
          Hosts are reached over Tailscale only. Start the daemon with{' '}
          <Text style={styles.mono}>COMMANDO_TAILSCALE=true</Text>; MagicDNS names also need{' '}
          <Text style={styles.mono}>COMMANDO_TRUSTED_ORIGINS</Text>.
        </Text>

        <Link asChild href="/settings">
          <Pressable style={styles.settingsLink}>
            <Feather color={theme.muted} name="settings" size={16} />
            <Text style={[styles.settingsLabel, { color: theme.muted }]}>Settings</Text>
          </Pressable>
        </Link>
      </ScrollView>

      <AddHostSheet onClose={() => setAddVisible(false)} visible={addVisible} />
      <SignInSheet host={signInHost} onClose={() => setSignInHost(null)} visible={signInHost !== null} />
    </SafeAreaView>
  )
}

function HostCard({
  host,
  reachability,
  editing,
  onSignIn,
  onRemove,
}: {
  host: Host
  reachability: HostReachability | undefined
  editing: boolean
  onSignIn: () => void
  onRemove: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const state = useDaemonStore((store) => store.byHost[host.id]) ?? EMPTY_HOST_STATE
  const counts = useMemo(
    () => agentCounts(buildAgentRows({ statuses: state.agentStatuses, snapshot: state.snapshot }), state.snapshot),
    [state.agentStatuses, state.snapshot],
  )

  const status = reachability?.state ?? 'unknown'
  const online = status === 'online'
  const connected = state.phase === 'live'

  const openHost = useCallback(() => {
    if (status === 'unauthorized') onSignIn()
    else router.push({ pathname: '/(host)/[hostId]/sessions', params: { hostId: host.id } })
  }, [host.id, onSignIn, router, status])

  return (
    <Pressable accessibilityRole="button" onPress={openHost}>
      <Card style={styles.hostCard}>
        <Dot
          tone={online ? 'green' : status === 'unauthorized' ? 'amber' : 'muted'}
          size={10}
        />
        <View style={styles.hostText}>
          <Text style={[styles.hostName, { color: theme.text }]}>{host.name}</Text>
          <Text style={[styles.hostAddress, styles.mono, { color: theme.muted }]}>
            {hostLabel(host)}
          </Text>
          {connected ? (
            <View style={styles.countsRow}>
              {counts.needsYou > 0 ? <Dot size={6} tone="amber" /> : null}
              <Text style={[styles.counts, { color: theme.muted }]}>
                {counts.needsYou} needs you · {counts.working} working · {counts.sessions} sessions
              </Text>
            </View>
          ) : (
            <Text style={[styles.counts, { color: theme.muted }]}>
              {hostSubtitle(status, reachability)}
            </Text>
          )}
        </View>
        {editing ? (
          <Pressable accessibilityLabel={`Remove ${host.name}`} onPress={onRemove}>
            <Feather color={theme.red} name="trash-2" size={18} />
          </Pressable>
        ) : (
          <Feather color={theme.textFaint} name="chevron-right" size={18} />
        )}
      </Card>
    </Pressable>
  )
}

function hostSubtitle(state: HostReachability['state'], reachability: HostReachability | undefined): string {
  if (state === 'checking') return 'Checking…'
  if (state === 'unauthorized') return 'Sign in required'
  if (state === 'online') return 'Reachable · connecting'
  if (state === 'offline') {
    const seen = reachability?.checkedAt ? relativeTime(reachability.checkedAt) : null
    return seen ? `Offline · checked ${seen} ago` : 'Offline'
  }
  return 'Not checked yet'
}

function AddHostSheet({ visible, onClose }: { visible: boolean; onClose: () => void }): React.JSX.Element {
  const theme = useTheme()
  const addHost = useHostsStore((state) => state.addHost)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    try {
      await addHost({ name, baseUrl: address })
      setName('')
      setAddress('')
      setError(null)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add that host')
    }
  }

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable accessibilityLabel="Dismiss" onPress={onClose} style={styles.backdrop} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.borderMid }]}>
          <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Add host</Text>
          <View style={[styles.field, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>Name</Text>
            <TextInput
              accessibilityLabel="Host name"
              autoCapitalize="none"
              onChangeText={setName}
              placeholder="studio"
              placeholderTextColor={theme.textDim}
              style={[styles.input, { color: theme.text }]}
              value={name}
            />
          </View>
          <View style={[styles.field, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>Address</Text>
            <TextInput
              accessibilityLabel="Host address"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setAddress}
              onSubmitEditing={() => void submit()}
              placeholder="studio.tail-1a2b.ts.net:4310"
              placeholderTextColor={theme.textDim}
              style={[styles.input, styles.mono, { color: theme.text }]}
              value={address}
            />
          </View>
          {error ? <Text style={[styles.error, { color: theme.red }]}>{error}</Text> : null}
          <Button label="Add" onPress={() => void submit()} variant="primary" />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 10 },
  action: { fontSize: 15, fontWeight: '600' },
  hostCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostText: { flex: 1, gap: 3 },
  hostName: { fontSize: 16, fontWeight: '600' },
  hostAddress: { fontSize: 12 },
  countsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  counts: { fontSize: 12 },
  footnote: { fontSize: 12.5, lineHeight: 18, paddingTop: 4 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  settingsLink: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  settingsLabel: { fontSize: 14, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 8,
    paddingBottom: 28,
    paddingHorizontal: 16,
    gap: 12,
  },
  grab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center' },
  sheetTitle: { fontSize: 20, fontWeight: '800' },
  field: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  fieldLabel: { fontSize: 12, fontWeight: '600', minWidth: 74 },
  input: { flex: 1, fontSize: 15, paddingVertical: 4 },
  error: { fontSize: 13 },
})
