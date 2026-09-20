import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { TmuxSplitDirection, TmuxSplitPlacement } from '@commando/tmux-create'

import { createTmuxPane } from '../../../src/daemon/paneApi'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import { useTheme } from '../../../src/theme'
import { CreateSheet } from '../../../src/ui/CreateSheet'
import { FormError, RowGroup, TextRow, ValueRow } from '../../../src/ui/formPrimitives'
import { Meta, SectionHeader, Segmented } from '../../../src/ui/primitives'

const DIRECTIONS: readonly { value: TmuxSplitDirection; label: string }[] = [
  { value: 'horizontal', label: 'Side by side' },
  { value: 'vertical', label: 'Stacked' },
]

const PLACEMENTS: readonly { value: TmuxSplitPlacement; label: string }[] = [
  { value: 'after', label: 'After' },
  { value: 'before', label: 'Before' },
]

type Target = { id: string; label: string; detail: string }

/** The split variant of screen 07: `POST /api/tmux/panes` against a window or pane. */
export default function NewPaneScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, targetId: initialTargetId } = useLocalSearchParams<{
    hostId: string
    targetId?: string
  }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const [targetId, setTargetId] = useState(initialTargetId ?? '')
  const [direction, setDirection] = useState<TmuxSplitDirection>('horizontal')
  const [placement, setPlacement] = useState<TmuxSplitPlacement>('after')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A split can be anchored to a window (tmux picks its active pane) or to a
  // specific pane, so both are offered in one list.
  const targets = useMemo<Target[]>(() => {
    const snapshot = state.snapshot
    if (!snapshot) return []
    const sessionName = new Map(snapshot.sessions.map((session) => [session.id, session.name]))
    const list: Target[] = []
    for (const window of snapshot.windows) {
      list.push({
        id: window.id,
        label: `${sessionName.get(window.sessionId) ?? window.sessionId} · ${window.index}: ${window.name}`,
        detail: 'active pane of this window',
      })
      for (const pane of snapshot.panes.filter((candidate) => candidate.windowId === window.id)) {
        list.push({
          id: pane.id,
          label: `${pane.title || pane.command} ${pane.targetId}`,
          detail: pane.path,
        })
      }
    }
    return list
  }, [state.snapshot])

  useEffect(() => {
    if (!targetId && targets[0]) setTargetId(targets[0].id)
  }, [targetId, targets])

  const target = targets.find((candidate) => candidate.id === targetId)

  const submit = useCallback(async () => {
    if (!host || !targetId) return
    setBusy(true)
    setError(null)
    try {
      const { created } = await createTmuxPane(host, {
        targetId,
        direction,
        placement,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      })
      router.replace({
        pathname: '/(host)/[hostId]/pane/[paneId]',
        params: { hostId: hostId ?? '', paneId: created.paneId },
      })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Splitting the pane failed')
      setBusy(false)
    }
  }, [cwd, direction, host, hostId, placement, router, targetId])

  return (
    <CreateSheet
      action="Split"
      actionEnabled={Boolean(targetId) && !busy}
      busy={busy}
      onAction={() => void submit()}
      onCancel={() => router.back()}
      subtitle={host ? `on ${host.name}` : undefined}
      title="New pane"
    >
      {error ? <FormError message={error} /> : null}

      <SectionHeader label="Split" />
      <View style={styles.targets}>
        {targets.map((candidate) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: candidate.id === targetId }}
            key={candidate.id}
            onPress={() => setTargetId(candidate.id)}
            style={[
              styles.target,
              {
                backgroundColor: theme.surface,
                borderColor: candidate.id === targetId ? theme.accent : theme.border,
              },
            ]}
          >
            <Text numberOfLines={1} style={[styles.targetLabel, { color: theme.text }]}>
              {candidate.label}
            </Text>
            <Text numberOfLines={1} style={[styles.targetDetail, { color: theme.muted }]}>
              {candidate.detail}
            </Text>
          </Pressable>
        ))}
        {targets.length === 0 ? <Meta>No windows on this host yet.</Meta> : null}
      </View>

      <SectionHeader label="Direction" />
      <Segmented onChange={setDirection} options={DIRECTIONS} value={direction} />

      <SectionHeader label="Placement" />
      <Segmented onChange={setPlacement} options={PLACEMENTS} value={placement} />

      <RowGroup>
        <ValueRow label="Target" value={target?.label ?? '—'} />
        <TextRow
          label="Directory"
          mono
          onChangeText={setCwd}
          placeholder="defaults to the target's directory"
          value={cwd}
        />
      </RowGroup>
    </CreateSheet>
  )
}

const styles = StyleSheet.create({
  targets: { gap: 8 },
  target: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  targetLabel: { fontSize: 14.5, fontWeight: '600' },
  targetDetail: { fontSize: 12 },
})
