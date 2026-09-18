import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { createTmuxWindow } from '../../../src/daemon/paneApi'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import { useTheme } from '../../../src/theme'
import { CreateSheet } from '../../../src/ui/CreateSheet'
import { FormError, RowGroup, TextRow, ValueRow } from '../../../src/ui/formPrimitives'
import { Meta, SectionHeader } from '../../../src/ui/primitives'

/**
 * The lighter variant of screen 07 for `POST /api/tmux/windows`: which session,
 * what the window is called, and where it starts.
 */
export default function NewWindowScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, sessionId: initialSessionId } = useLocalSearchParams<{
    hostId: string
    sessionId?: string
  }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const sessions = useMemo(() => state.snapshot?.sessions ?? [], [state.snapshot])
  const [sessionId, setSessionId] = useState(initialSessionId ?? '')
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId && sessions[0]) setSessionId(sessions[0].id)
  }, [sessionId, sessions])

  const session = sessions.find((candidate) => candidate.id === sessionId)

  const submit = useCallback(async () => {
    if (!host || !sessionId) return
    setBusy(true)
    setError(null)
    try {
      const { created } = await createTmuxWindow(host, {
        sessionId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      })
      router.replace({
        pathname: '/(host)/[hostId]/pane/[paneId]',
        params: { hostId: hostId ?? '', paneId: created.paneId },
      })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Creating the window failed')
      setBusy(false)
    }
  }, [cwd, host, hostId, name, router, sessionId])

  return (
    <CreateSheet
      action="Create"
      actionEnabled={Boolean(sessionId) && !busy}
      busy={busy}
      onAction={() => void submit()}
      onCancel={() => router.back()}
      subtitle={host ? `on ${host.name}` : undefined}
      title="New window"
    >
      {error ? <FormError message={error} /> : null}

      <SectionHeader label="Session" />
      <View style={styles.sessions}>
        {sessions.map((candidate) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: candidate.id === sessionId }}
            key={candidate.id}
            onPress={() => setSessionId(candidate.id)}
            style={[
              styles.session,
              {
                backgroundColor: theme.surface,
                borderColor: candidate.id === sessionId ? theme.accent : theme.border,
              },
            ]}
          >
            <Text style={[styles.sessionName, { color: theme.text }]}>{candidate.name}</Text>
            <Text style={[styles.sessionMeta, { color: theme.muted }]}>
              {candidate.windowIds.length} {candidate.windowIds.length === 1 ? 'window' : 'windows'}
            </Text>
          </Pressable>
        ))}
        {sessions.length === 0 ? <Meta>No sessions on this host yet.</Meta> : null}
      </View>

      <RowGroup>
        <ValueRow label="Session" value={session?.name ?? '—'} />
        <TextRow label="Name" onChangeText={setName} placeholder="agent" value={name} />
        <TextRow
          label="Directory"
          mono
          onChangeText={setCwd}
          placeholder="defaults to the session's directory"
          value={cwd}
        />
      </RowGroup>
    </CreateSheet>
  )
}

const styles = StyleSheet.create({
  sessions: { gap: 8 },
  session: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sessionName: { fontSize: 15, fontWeight: '600' },
  sessionMeta: { fontSize: 12 },
})
