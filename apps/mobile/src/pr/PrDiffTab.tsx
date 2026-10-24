import { memo, useCallback, useMemo, useState } from 'react'
import { FlatList, Linking, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { useTheme, type Theme } from '../theme'
import { Meta } from '../ui/primitives'
import type { PrRemoteDiff } from './api'
import { prDiffTotals, prFileRows, type PrFileRow } from './diff'
import { PatchView } from './PatchView'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/**
 * The changed files as a virtualised list; a file's patch is parsed and drawn
 * only once it is opened, and a long one in chunks (see `PatchView`).
 */
export function PrDiffTab({ diff, error, loading, onRefresh, url, baseRefName }: {
  diff?: PrRemoteDiff | undefined
  error?: string | undefined
  loading: boolean
  onRefresh: () => void
  url: string
  baseRefName?: string | undefined
}): React.JSX.Element {
  const theme = useTheme()
  const rows = useMemo(() => prFileRows(diff), [diff])
  const totals = useMemo(() => prDiffTotals(diff), [diff])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((path: string) => setOpen((current) => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  }), [])
  const header = (
    <View style={styles.header}>
      {diff ? (
        <Text style={[styles.headline, { color: theme.textSoft }]}>
          {totals.files} {totals.files === 1 ? 'file' : 'files'} · <Text style={{ color: theme.green }}>+{totals.additions}</Text> <Text style={{ color: theme.red }}>−{totals.deletions}</Text>
          <Text style={{ color: theme.muted }}> · against {baseRefName ?? 'its base'}</Text>
        </Text>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={[styles.note, { color: theme.red }]}>{error}</Text> : null}
      {!diff && !error ? <Meta>Reading the changed files…</Meta> : null}
    </View>
  )
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.path}
      extraData={open}
      ListHeaderComponent={header}
      ListFooterComponent={diff?.truncated ? <Text style={[styles.note, styles.footer, { color: theme.muted }]} onPress={() => void Linking.openURL(`${url}/files`)}>GitHub lists at most 3,000 files. Open the rest on GitHub.</Text> : null}
      renderItem={({ item }) => <FileRow row={item} open={open.has(item.path)} onToggle={toggle} url={url} />}
      contentContainerStyle={styles.list}
      initialNumToRender={16}
      maxToRenderPerBatch={8}
      windowSize={7}
      refreshControl={<RefreshControl refreshing={loading && Boolean(diff)} onRefresh={onRefresh} tintColor={theme.muted} />}
    />
  )
}

const FileRow = memo(function FileRow({ row, open, onToggle, url }: { row: PrFileRow; open: boolean; onToggle: (path: string) => void; url: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.file, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.path}, ${row.status}, ${row.additions} added, ${row.deletions} removed`}
        accessibilityState={{ expanded: open }}
        onPress={() => onToggle(row.path)}
        style={styles.fileHead}
      >
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={15} color={theme.muted} />
        <Text style={[styles.badge, { color: badgeColor(theme, row.badge), borderColor: badgeColor(theme, row.badge) }]}>{row.badge}</Text>
        <View style={styles.fileName}>
          <Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>{row.name}</Text>
          {row.directory ? <Text numberOfLines={1} ellipsizeMode="head" style={[styles.directory, { color: theme.muted }]}>{row.directory}</Text> : null}
        </View>
        <Text style={styles.counts}>
          <Text style={{ color: theme.green }}>+{row.additions}</Text> <Text style={{ color: theme.red }}>−{row.deletions}</Text>
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.patch}>
          {row.patch ? <PatchView patch={row.patch} /> : (
            <Text style={[styles.note, { color: theme.muted }]} onPress={() => void Linking.openURL(`${url}/files`)}>
              GitHub sends no text diff for this file (binary, or too large). <Text style={{ color: theme.accent }}>Open on GitHub</Text>
            </Text>
          )}
        </View>
      ) : null}
    </View>
  )
})

function badgeColor(theme: Theme, badge: PrFileRow['badge']): string {
  return badge === 'A' ? theme.green : badge === 'D' ? theme.red : badge === 'M' ? theme.amber : theme.cyan
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 8, maxWidth: 900, width: '100%', alignSelf: 'center' },
  header: { gap: 6, paddingBottom: 4 },
  headline: { fontSize: 13.5, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12.5, lineHeight: 17 },
  footer: { paddingTop: 8 },
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  fileHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  badge: { fontFamily: MONO, fontSize: 10.5, fontWeight: '700', borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, overflow: 'hidden' },
  fileName: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '600' },
  directory: { fontSize: 11.5, fontFamily: MONO },
  counts: { fontSize: 12, fontVariant: ['tabular-nums'] },
  patch: { paddingHorizontal: 8, paddingBottom: 8 },
})
