import { useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'
import { prMergeDisabledReason } from '@commando/pr-merge'

import { Markdown } from '../chat/Markdown'
import type { PanePrSummary } from '../daemon/paneApi'
import type { Host } from '../hosts/types'
import { panePrCache } from '../pane/prCache'
import { prChips } from '../pane/prs'
import { useTheme } from '../theme'
import { relativeTime } from '../time'
import { Meta, Pill, Segmented } from '../ui/primitives'
import { fetchPrDetails, fetchPrDiff, fetchPrPreview, mergePr, type PrDetails, type PrPreview } from './api'
import { usePrResource } from './cache'
import { prDiffTotals } from './diff'
import { githubMarkdown } from './markdown'
import { PrConversationTab } from './PrConversationTab'
import { PrDiffTab } from './PrDiffTab'
import { StaleNote } from './StaleNote'
import { prTimeline } from './timeline'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/** The daemon's conversation cache lives for 60 s; asking more often only returns the same copy. */
const DETAILS_TTL_MS = 60_000
const PREVIEW_TTL_MS = 5 * 60_000

export type PrTab = 'description' | 'diff' | 'conversation'

export type PrViewSource = Pick<PanePrSummary, 'repo' | 'number'> & Partial<Pick<PanePrSummary, 'title' | 'url' | 'state' | 'isDraft' | 'updatedAt' | 'preview'>>

/**
 * A pull request on the phone: Description, Diff and Conversation, over the
 * same daemon routes the desktop's PR panel reads (`/api/prs/details`,
 * `/api/prs/diff`). Details load when the view is shown, the diff only when
 * its tab is first opened, and nothing polls — pull down to refresh.
 */
export function PrView({ host, source, active = true, initialTab = 'description' }: {
  host: Host
  source: PrViewSource
  active?: boolean
  initialTab?: PrTab
}): React.JSX.Element {
  const theme = useTheme()
  const [tab, setTab] = useState<PrTab>(initialTab)
  const { repo, number } = source
  const scope = `${host.id}:${host.baseUrl}:${repo.toLowerCase()}#${number}`

  const fallback = usePrResource<PrPreview>(`preview:${scope}`, () => fetchPrPreview(host, repo, number), { enabled: active && !source.preview, ttlMs: PREVIEW_TTL_MS })
  const details = usePrResource<PrDetails>(`details:${scope}`, (refresh) => fetchPrDetails(host, repo, number, { refresh }), { enabled: active, ttlMs: DETAILS_TTL_MS })
  const preview = source.preview ?? fallback.data
  // Details are re-read every minute while shown; a fallback preview is not, so the details' head wins.
  const head = details.data?.headOid ?? preview?.headRefOid
  // A diff is pinned to the head it was read at, so it is kept until the PR moves.
  const diff = usePrResource(`diff:${scope}:${head ?? 'head'}`, () => fetchPrDiff(host, repo, number), { enabled: active && tab === 'diff', ttlMs: head ? Number.POSITIVE_INFINITY : PREVIEW_TTL_MS })

  const timeline = useMemo(() => prTimeline(details.data?.conversation ?? []), [details.data])
  const totals = prDiffTotals(diff.data)
  const url = source.url ?? preview?.url ?? `https://github.com/${repo}/pull/${number}`
  const fileCount = diff.data ? totals.files : preview?.changedFiles
  const tabs = [
    { value: 'description' as const, label: 'Description' },
    { value: 'diff' as const, label: fileCount ? `Diff · ${fileCount}` : 'Diff' },
    { value: 'conversation' as const, label: details.data ? `Conversation · ${timeline.length}` : 'Conversation' },
  ]
  const refreshing = details.loading && Boolean(details.data)
  // Shown as merged straight away; the pane's PR list catches up on the refresh below.
  const [merged, setMerged] = useState(false)
  const base = details.data?.mergeTarget?.branch ?? preview?.baseRefName
  // Mergeability lives on the preview, so a pull re-reads that too (the pane's list, or the fallback).
  const refreshAll = () => {
    void details.refresh()
    if (source.preview) void panePrCache.refreshHost(host)
    else void fallback.refresh()
  }
  const afterMerge = (ok: boolean) => {
    if (ok) setMerged(true)
    refreshAll()
  }

  return (
    <View style={styles.root}>
      <View style={[styles.tabs, { borderBottomColor: theme.border }]}>
        <Segmented options={tabs} value={tab} onChange={setTab} />
      </View>
      {tab === 'description' ? (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={theme.muted} />}
        >
          <PrHeader source={source} preview={preview} details={details.data} url={url} merged={merged}>
            <MergeButton host={host} source={source} preview={preview} merged={merged} head={head} base={base} onSettled={afterMerge} />
          </PrHeader>
          {details.error ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{details.error}</Text> : null}
          {details.data?.stale ? <StaleNote details={details.data} /> : null}
          <View style={[styles.rule, { backgroundColor: theme.border }]} />
          {details.data ? (
            <Markdown text={githubMarkdown(details.data.body) || '_No description provided._'} baseUrl="" />
          ) : !details.error ? (
            <Meta>Loading the description…</Meta>
          ) : null}
        </ScrollView>
      ) : tab === 'diff' ? (
        <PrDiffTab diff={diff.data} error={diff.error} loading={diff.loading} onRefresh={() => void diff.refresh()} url={url} baseRefName={preview?.baseRefName ?? details.data?.mergeTarget?.branch} />
      ) : (
        <PrConversationTab items={timeline} details={details.data} error={details.error} loading={details.loading} onRefresh={() => void details.refresh()} url={url} />
      )}
    </View>
  )
}

function PrHeader({ source, preview, details, url, merged, children }: {
  source: PrViewSource
  preview?: PrPreview | undefined
  details?: PrDetails | undefined
  url: string
  merged: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const state = merged ? 'merged' : preview?.state ?? source.state ?? 'open'
  const draft = (preview?.isDraft ?? source.isDraft) && state === 'open'
  const title = preview?.title ?? source.title ?? `Pull request #${source.number}`
  const base = details?.mergeTarget?.branch ?? preview?.baseRefName
  const checks = details?.checks
  const chips = prChips({
    number: source.number,
    state,
    isDraft: Boolean(draft),
    conflicting: preview?.conflicting ?? source.preview?.conflicting ?? false,
    unresolvedThreads: details?.unresolvedThreads ?? preview?.unresolvedThreads ?? 0,
    reviewDecision: preview?.reviewDecision ?? null,
    // The details' own check runs are fresher than the list's rollup when both are there.
    checks: checks?.length
      ? {
          state: checks.some((run) => run.state === 'fail') ? 'fail' : checks.some((run) => run.state === 'pending') ? 'pending' : 'pass',
          failed: checks.filter((run) => run.state === 'fail').length,
          pending: checks.filter((run) => run.state === 'pending').length,
          total: checks.length,
        }
      : preview?.checks ?? null,
  })
  const attention = (checks ?? []).filter((run) => run.state !== 'pass')
  const counts = [
    preview?.author ? `by ${preview.author}` : null,
    preview?.commitCount ? `${preview.commitCount} ${preview.commitCount === 1 ? 'commit' : 'commits'}` : null,
    preview?.changedFiles ? `${preview.changedFiles} ${preview.changedFiles === 1 ? 'file' : 'files'}` : null,
    preview?.updatedAt ? `updated ${relativeTime(Date.parse(preview.updatedAt)) || 'now'}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <View style={styles.header}>
      <Text style={[styles.repo, { color: theme.muted }]}>{source.repo} · #{source.number}</Text>
      <Text selectable accessibilityRole="header" style={[styles.title, { color: theme.text }]}>{title}</Text>
      <View style={styles.wrapRow}>
        <Pill label={draft ? 'Draft' : state === 'open' ? 'Open' : state === 'merged' ? 'Merged' : 'Closed'} tone={draft ? 'mute' : state === 'open' ? 'ok' : state === 'merged' ? 'claude' : 'bad'} />
        {preview?.headRefName || base ? (
          <Text numberOfLines={2} style={[styles.branches, { color: theme.textSoft }]}>
            {preview?.headRefName ?? '…'} <Text style={{ color: theme.muted }}>→</Text> {base ?? '…'}
          </Text>
        ) : null}
      </View>
      {counts || preview?.additions !== undefined ? (
        <Text style={[styles.meta, { color: theme.muted }]}>
          {counts}
          {preview?.additions !== undefined ? <>
            {counts ? ' · ' : ''}<Text style={{ color: theme.green }}>+{preview.additions}</Text> <Text style={{ color: theme.red }}>−{preview.deletions ?? 0}</Text>
          </> : null}
        </Text>
      ) : null}
      {chips.length ? <View style={styles.wrapRow}>{chips.map((chip) => <Pill key={chip.label} label={chip.label} tone={chip.tone} />)}</View> : null}
      {attention.length ? (
        <View style={styles.checks}>
          {attention.slice(0, 6).map((run, index) => (
            <Pressable key={`${run.name}:${index}`} disabled={!run.url} accessibilityRole={run.url ? 'link' : 'text'} onPress={() => void Linking.openURL(run.url).catch(() => undefined)} style={styles.check}>
              <Text style={{ color: run.state === 'fail' ? theme.red : theme.amber }}>{run.state === 'fail' ? '✕' : '●'}</Text>
              <Text numberOfLines={1} style={[styles.checkName, { color: theme.textSoft }]}>{run.name}</Text>
            </Pressable>
          ))}
          {attention.length > 6 ? <Meta>and {attention.length - 6} more</Meta> : null}
        </View>
      ) : null}
      <View style={styles.wrapRow}>
        <Pressable accessibilityRole="link" accessibilityLabel={`Open #${source.number} on GitHub`} onPress={() => void Linking.openURL(url).catch(() => undefined)} style={[styles.action, { borderColor: theme.borderMid, backgroundColor: theme.surfaceSoft }]}>
          <Feather name="external-link" size={14} color={theme.text} />
          <Text style={[styles.actionLabel, { color: theme.text }]}>Open on GitHub</Text>
        </Pressable>
        {children}
      </View>
    </View>
  )
}

/**
 * The desktop panel's Merge PR, behind a confirmation. It is offered only for
 * an open PR and greyed out with GitHub's reason when the PR can't merge yet;
 * the daemon checks again before merging, so a stale list only costs an error.
 */
function MergeButton({ host, source, preview, merged, head, base, onSettled }: {
  host: Host
  source: PrViewSource
  preview?: PrPreview | undefined
  merged: boolean
  head?: string | undefined
  base?: string | undefined
  onSettled: (merged: boolean) => void
}): React.JSX.Element | null {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const state = merged ? 'merged' : preview?.state ?? source.state ?? 'open'
  if (state !== 'open') return null
  const reason = prMergeDisabledReason({
    state,
    isDraft: Boolean(preview?.isDraft ?? source.isDraft),
    ...(preview?.mergeable ? { mergeable: preview.mergeable } : {}),
    ...(preview?.mergeStateStatus ? { mergeStateStatus: preview.mergeStateStatus } : {}),
  }) ?? (head ? null : 'Loading the PR’s latest commit…')

  const merge = async (headRefOid: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    let ok = false
    try {
      await mergePr(host, source.repo, source.number, headRefOid, base)
      ok = true
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Unable to merge pull request')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
    } finally {
      inFlight.current = false
      setBusy(false)
      onSettled(ok)
    }
  }
  const confirm = () => {
    if (!head) return
    const branches = preview?.headRefName && base ? `${preview.headRefName} into ${base}` : base ? `into ${base}` : 'this pull request'
    Alert.alert(`Merge #${source.number}?`, `This merges ${branches} on GitHub.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Merge', onPress: () => void merge(head) },
    ])
  }

  const disabled = Boolean(reason) || busy
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Merge #${source.number}`}
        accessibilityState={{ disabled, busy }}
        accessibilityHint={reason ?? undefined}
        disabled={disabled}
        onPress={confirm}
        style={[styles.action, { borderColor: 'transparent', backgroundColor: theme.accent, opacity: reason ? 0.5 : 1 }]}
      >
        {busy ? <ActivityIndicator size="small" color={theme.accentInk} /> : <Feather name="git-merge" size={14} color={theme.accentInk} />}
        <Text style={[styles.actionLabel, { color: theme.accentInk }]}>{busy ? 'Merging…' : 'Merge PR'}</Text>
      </Pressable>
      {reason && !busy ? <Meta style={styles.fullRow}>{reason}</Meta> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.error, styles.fullRow, { color: theme.red }]}>{error}</Text> : null}
    </>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  tabs: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { padding: 20, gap: 14, maxWidth: 776, width: '100%', alignSelf: 'center' },
  header: { gap: 10 },
  repo: { fontSize: 12.5, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 26 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  branches: { fontFamily: MONO, fontSize: 12, flexShrink: 1 },
  meta: { fontSize: 13, lineHeight: 18 },
  checks: { gap: 4 },
  check: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  checkName: { fontSize: 13, flexShrink: 1 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  actionLabel: { fontSize: 13.5, fontWeight: '600' },
  fullRow: { width: '100%' },
  rule: { height: StyleSheet.hairlineWidth },
  error: { fontSize: 13.5 },
})
