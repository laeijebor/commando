import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type {
  AgentStatus,
  OpenPort,
  PaneScreenshotFolder,
  SessionBrief,
  TmuxPane,
} from '@commando/protocol'

import {
  fetchGitSummary,
  fetchFileDiff,
  fetchPanePrs,
  fetchRepoPrs,
  fetchScreenshotFolder,
  screenshotImageSource,
  type GitDiffSummary,
  type PanePrList,
  type PaneScreenshotListing,
} from '../daemon/paneApi'
import type { Host } from '../hosts/types'
import { changesHeadline, gitSummaryView, parseDiffLines } from '../pane/gitSummary'
import { prChips, type PrDetail } from '../pane/prs'
import type { MarkdownBlock } from '../pane/markdown'
import {
  buildWorklogView,
  hudDetailsView,
  UPDATE_KIND_LABEL,
  type TimelineEntry,
} from '../pane/worklog'
import { openTile } from '../tiles/api'
import { relativeTime } from '../time'
import { statusLabel, useTheme, type Theme } from '../theme'
import {
  Button,
  Card,
  Meta,
  Pill,
  ProgressBar,
  SectionHeader,
  StatusDot,
  withAlpha,
} from './primitives'

/** How often the Changes section re-reads the diff, matching `src/PaneGitStats.tsx`. */
const GIT_POLL_INTERVAL_MS = 15_000

const SECTION_IDS = ['worklog', 'changes', 'pr', 'ports', 'screenshots'] as const

type SectionId = (typeof SECTION_IDS)[number]

const SECTION_LABELS: Record<SectionId, string> = {
  worklog: 'Worklog',
  changes: 'Changes',
  pr: 'PR',
  ports: 'Ports',
  screenshots: 'Screenshots',
}

export type PaneInfoSectionId = SectionId

export const PANE_INFO_SECTION_IDS = SECTION_IDS

export type PaneInfoSectionsProps = {
  host: Host
  paneId: string
  brief?: SessionBrief
  status?: AgentStatus
  pane?: TmuxPane
  ports: readonly OpenPort[]
  /** Which sections to draw. Defaults to all five, in the sheet's order. */
  sections?: readonly SectionId[]
  /** Where each section starts, for a chip row that scrolls to it. */
  onLayoutSection?: (section: SectionId, y: number) => void
}

/**
 * Everything the desktop shows to the right of a pane — worklog, changes, pull
 * request, ports and screenshots — along with the polling, the file-diff
 * viewer and the screenshot viewer that go with them, but no chrome of its own.
 *
 * The Info sheet stacks all five under its chip row; the iPad cockpit's HUD
 * column takes the first four and leaves the screenshots to the sheet.
 */
export function PaneInfoSections({
  host,
  paneId,
  brief,
  status,
  pane,
  ports,
  sections = SECTION_IDS,
  onLayoutSection,
}: PaneInfoSectionsProps): React.JSX.Element {
  const theme = useTheme()
  const [summary, setSummary] = useState<GitDiffSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [prs, setPrs] = useState<PanePrList | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [prDetails, setPrDetails] = useState<Record<number, PrDetail>>({})
  const [diff, setDiff] = useState<{ file: string; diff: string } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<PaneScreenshotListing | null>(null)
  const [viewerIndex, setViewerIndex] = useState(0)
  const [tileNote, setTileNote] = useState<string | null>(null)

  const worklog = useMemo(() => (brief ? buildWorklogView(brief) : null), [brief])
  const hud = useMemo(() => (brief ? null : hudDetailsView(status)), [brief, status])
  const changes = useMemo(() => gitSummaryView(summary), [summary])
  const sessionPorts = useMemo(
    () => ports.filter((port) => (pane ? port.sessionId === pane.sessionId : port.paneId === paneId)),
    [pane, paneId, ports],
  )
  const state = worklog?.state ?? status?.status ?? 'unknown'

  // The diff is the one part of this sheet the daemon does not push, so it is
  // polled while the sheet is open, exactly like the desktop's git stats.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await fetchGitSummary(host, paneId)
        if (cancelled) return
        setSummary(next)
        setSummaryError(null)
      } catch (error) {
        if (cancelled) return
        setSummaryError(error instanceof Error ? error.message : 'Git summary failed')
      }
    }
    void load()
    const timer = setInterval(() => void load(), GIT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [host, paneId])

  useEffect(() => {
    let cancelled = false
    fetchPanePrs(host, paneId)
      .then(async (list) => {
        if (cancelled) return
        setPrs(list)
        setPrError(null)
        // The checks and review state only exist on the repository list, so it
        // is asked for once a pane is known to have an open PR.
        const repo = list.pullRequests.find((pullRequest) => pullRequest.state === 'open')?.repo
        if (!repo) return
        const full = await fetchRepoPrs(host, repo).catch(() => null)
        if (cancelled || !full) return
        setPrDetails(Object.fromEntries(full.pullRequests.map((entry) => [entry.number, entry])))
      })
      .catch((error: unknown) => {
        if (!cancelled) setPrError(error instanceof Error ? error.message : 'PR lookup failed')
      })
    return () => {
      cancelled = true
    }
  }, [host, paneId])

  const openDiff = useCallback(async (file: string) => {
    setDiffError(null)
    setDiff({ file, diff: '' })
    try {
      const result = await fetchFileDiff(host, paneId, file)
      setDiff(result)
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : 'File diff failed')
    }
  }, [host, paneId])

  const openFolder = useCallback(async (folder: PaneScreenshotFolder, index = 0) => {
    setViewerIndex(index)
    setViewer({ ...folder, files: folder.preview })
    try {
      const listing = await fetchScreenshotFolder(host, folder.id)
      setViewer(listing)
    } catch {
      // The preview files the brief already carries stay on screen.
    }
  }, [host])

  const openAsTile = useCallback(async (port: number) => {
    setTileNote(null)
    try {
      const result = await openTile(host, {
        url: `http://localhost:${port}`,
        anchor: paneId,
        engine: 'chromium',
      })
      setTileNote(result.status === 'pending' ? 'Tile needs confirming on the Mac' : `Opened tile for port ${port}`)
    } catch (error) {
      setTileNote(error instanceof Error ? error.message : 'Opening the tile failed')
    }
  }, [host, paneId])

  const onSectionLayout = (section: SectionId) => (event: { nativeEvent: { layout: { y: number } } }) => {
    onLayoutSection?.(section, event.nativeEvent.layout.y)
  }

  const shows = (section: SectionId): boolean => sections.includes(section)

  return (
    <>
      {shows('worklog') ? (
        <View onLayout={onSectionLayout('worklog')} style={styles.section}>
          {worklog ? (
            <>
              <Card raised style={styles.headlineCard}>
                <View style={styles.headlineRow}>
                  <View style={styles.headlineDot}>
                    <StatusDot size={9} status={worklog.state} />
                  </View>
                  <View style={styles.headlineText}>
                    <Text style={[styles.headline, { color: theme.text }]}>{worklog.headline}</Text>
                    <Text style={[styles.headlineMeta, { color: theme.muted }]}>
                      Worklog · from {worklog.headlineSource}
                    </Text>
                  </View>
                </View>
                {worklog.recap.length ? <Markdown blocks={worklog.recap} /> : null}
                {worklog.next ? (
                  <View style={[styles.nextRow, { borderTopColor: theme.border }]}>
                    <Text style={[styles.nextLabel, { color: theme.muted }]}>Next</Text>
                    <Text style={[styles.nextValue, { color: theme.text }]}>{worklog.next}</Text>
                  </View>
                ) : null}
              </Card>

              {worklog.plan.tasks.length ? (
                <>
                  <SectionHeader
                    label="Plan"
                    note={`${worklog.plan.completed} / ${worklog.plan.total}`}
                  />
                  <ProgressBar ratio={worklog.plan.ratio} />
                  <View style={styles.tasks}>
                    {worklog.plan.tasks.map((task) => (
                      <View key={task.id} style={styles.task}>
                        <TaskBox status={task.status} />
                        <Text
                          style={[
                            styles.taskLabel,
                            {
                              color: task.status === 'completed' || task.status === 'cancelled'
                                ? theme.muted
                                : theme.text,
                            },
                            task.status === 'completed' || task.status === 'cancelled'
                              ? styles.taskDone
                              : null,
                          ]}
                        >
                          {task.content}
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}

              {worklog.timeline.length ? (
                <>
                  <SectionHeader label="Activity" note={String(worklog.timeline.length)} />
                  <View style={styles.timeline}>
                    {worklog.timeline.map((entry) => (
                      <TimelineRow entry={entry} key={entry.id} />
                    ))}
                  </View>
                </>
              ) : null}
            </>
          ) : hud ? (
            <Card raised style={styles.headlineCard}>
              <View style={styles.headlineRow}>
                <View style={styles.headlineDot}>
                  <StatusDot size={9} status={state} />
                </View>
                <View style={styles.headlineText}>
                  <Text style={[styles.headline, { color: theme.text }]}>
                    {hud.intent ?? status?.summary ?? 'No worklog yet'}
                  </Text>
                  <Text style={[styles.headlineMeta, { color: theme.muted }]}>
                    HUD details · no worklog published
                  </Text>
                </View>
              </View>
              {hud.activity ? (
                <Text style={[styles.hudActivity, { color: theme.textSoft }]}>{hud.activity}</Text>
              ) : null}
              {hud.plan.total ? (
                <>
                  <ProgressBar ratio={hud.plan.ratio} />
                  <Meta>{hud.plan.completed} of {hud.plan.total} tasks</Meta>
                </>
              ) : null}
              {hud.checks.length || hud.changes ? (
                <View style={styles.chipCluster}>
                  {hud.checks.map((check) => (
                    <Pill
                      key={check.label}
                      label={check.label}
                      tone={check.status === 'passed' ? 'ok' : check.status === 'failed' ? 'bad' : 'warn'}
                    />
                  ))}
                  {hud.changes ? (
                    <Pill
                      label={`${hud.changes.fileCount} files +${hud.changes.additions} −${hud.changes.deletions}`}
                      tone="mute"
                    />
                  ) : null}
                </View>
              ) : null}
            </Card>
          ) : (
            <Card raised>
              <Text style={[styles.empty, { color: theme.muted }]}>
                No worklog or HUD details for this pane yet.
              </Text>
            </Card>
          )}
        </View>
      ) : null}

      {shows('changes') ? (
        <View onLayout={onSectionLayout('changes')} style={styles.section}>
          <SectionHeader label="Changes" note={changes ? changesHeadline(changes) : undefined} />
          {changes?.isRepo === false ? (
            <Meta>This pane is not inside a git checkout.</Meta>
          ) : changes ? (
            <>
              {changes.target ? <Meta>against {changes.target}</Meta> : null}
              {changes.rows.length === 0 ? (
                <Meta>No changes against the target yet.</Meta>
              ) : (
                <View style={styles.files}>
                  {changes.rows.map((row) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`View diff for ${row.path}`}
                      key={row.path}
                      onPress={() => void openDiff(row.path)}
                      style={[styles.fileRow, { borderColor: theme.border, backgroundColor: theme.surface }]}
                    >
                      <View style={styles.fileText}>
                        <Text numberOfLines={1} style={[styles.fileName, { color: theme.textSoft }]}>
                          {row.name}
                        </Text>
                        {row.directory ? (
                          <Text numberOfLines={1} style={[styles.fileDir, { color: theme.textDim }]}>
                            {row.directory}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={styles.fileStat}>
                        <Text style={{ color: theme.green }}>+{row.additions ?? 0}</Text>
                        <Text style={{ color: theme.muted }}> </Text>
                        <Text style={{ color: theme.red }}>−{row.deletions ?? 0}</Text>
                      </Text>
                      <Feather color={theme.textFaint} name="chevron-right" size={16} />
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          ) : summaryError ? (
            <Meta>{summaryError}</Meta>
          ) : (
            <Meta>Reading the diff…</Meta>
          )}
        </View>
      ) : null}

      {shows('pr') ? (
        <View onLayout={onSectionLayout('pr')} style={styles.section}>
          <SectionHeader label="Pull request" note={prs?.totalCount ? String(prs.totalCount) : undefined} />
          {prs?.pullRequests.length ? (
            prs.pullRequests.map((pullRequest) => (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Open pull request ${pullRequest.repo} #${pullRequest.number}`}
                key={pullRequest.url}
                onPress={() => void Linking.openURL(pullRequest.url)}
              >
                <Card style={styles.prCard}>
                  <View style={styles.prHead}>
                    <Text style={[styles.prNumber, { color: theme.muted }]}>#{pullRequest.number}</Text>
                    <Pill
                      label={pullRequest.isDraft ? 'Draft' : capitalise(pullRequest.state)}
                      tone={pullRequest.state === 'merged' ? 'claude' : pullRequest.state === 'closed' ? 'bad' : 'mute'}
                    />
                    <Text numberOfLines={1} style={[styles.prTitle, { color: theme.text }]}>
                      {pullRequest.title}
                    </Text>
                  </View>
                  {prChips(prDetails[pullRequest.number]).length ? (
                    <View style={styles.chipCluster}>
                      {prChips(prDetails[pullRequest.number]).map((chip) => (
                        <Pill key={chip.label} label={chip.label} tone={chip.tone} />
                      ))}
                    </View>
                  ) : null}
                  <Meta>{pullRequest.repo} · updated {relativeTime(Date.parse(pullRequest.updatedAt))}</Meta>
                </Card>
              </Pressable>
            ))
          ) : changes?.pullRequest ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(changes.pullRequest?.url ?? '')}
            >
              <Card style={styles.prCard}>
                <View style={styles.prHead}>
                  <Text style={[styles.prNumber, { color: theme.muted }]}>#{changes.pullRequest.number}</Text>
                  <Pill label={changes.pullRequest.isDraft ? 'Draft' : 'Open'} tone="mute" />
                  <Text numberOfLines={1} style={[styles.prTitle, { color: theme.text }]}>
                    {changes.pullRequest.title}
                  </Text>
                </View>
              </Card>
            </Pressable>
          ) : (
            <Meta>{prError ?? 'No pull request links this pane yet.'}</Meta>
          )}
        </View>
      ) : null}

      {shows('ports') ? (
        <View onLayout={onSectionLayout('ports')} style={styles.section}>
          <SectionHeader label="Ports" note={sessionPorts.length ? String(sessionPorts.length) : undefined} />
          {sessionPorts.length === 0 ? (
            <Meta>Nothing is listening for this session.</Meta>
          ) : (
            sessionPorts.map((port) => (
              <Card key={`${port.port}-${port.paneId}`} style={styles.portRow}>
                <View style={styles.portText}>
                  <Text style={[styles.portNumber, { color: theme.text }]}>:{port.port}</Text>
                  <Text style={[styles.portProcess, { color: theme.muted }]}>{port.processName}</Text>
                </View>
                <Button
                  label="Open as tile"
                  onPress={() => void openAsTile(port.port)}
                  style={styles.portButton}
                />
              </Card>
            ))
          )}
          {tileNote ? <Meta>{tileNote}</Meta> : null}
        </View>
      ) : null}

      {shows('screenshots') ? (
        <View onLayout={onSectionLayout('screenshots')} style={styles.section}>
          <SectionHeader
            label="Screenshots"
            note={worklog?.screenshots.length ? String(worklog.screenshots.length) : undefined}
          />
          {worklog?.screenshots.length ? (
            worklog.screenshots.map((folder) => (
              <View key={folder.id} style={styles.folder}>
                <Text style={[styles.folderTopic, { color: theme.textSoft }]}>
                  {folder.topic}
                  <Text style={{ color: theme.textDim }}>
                    {' '}· {folder.imageCount} {folder.imageCount === 1 ? 'image' : 'images'}
                  </Text>
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.thumbs}>
                    {folder.preview.map((file, index) => (
                      <Pressable
                        accessibilityRole="imagebutton"
                        accessibilityLabel={`Open ${file.name}`}
                        key={file.name}
                        onPress={() => void openFolder(folder, index)}
                      >
                        <Image
                          source={screenshotImageSource(host, folder.id, file)}
                          style={[styles.thumb, { borderColor: theme.border }]}
                        />
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </View>
            ))
          ) : (
            <Meta>No screenshot folders registered for this pane.</Meta>
          )}
        </View>
      ) : null}

      <Modal animationType="slide" onRequestClose={() => setDiff(null)} visible={diff !== null}>
        <View style={[styles.modal, { backgroundColor: theme.bg }]}>
          <View style={styles.modalHead}>
            <Text numberOfLines={1} style={[styles.modalTitle, { color: theme.text }]}>
              {diff?.file ?? ''}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setDiff(null)}>
              <Text style={[styles.backLabel, { color: theme.accent }]}>Done</Text>
            </Pressable>
          </View>
          <ScrollView horizontal>
            <ScrollView contentContainerStyle={styles.diffBody}>
              {diffError ? <Meta>{diffError}</Meta> : null}
              {!diffError && !diff?.diff ? <Meta>Reading the diff…</Meta> : null}
              {diff?.diff
                ? parseDiffLines(diff.diff).map((line, index) => (
                  <Text
                    key={`${index}-${line.text.slice(0, 12)}`}
                    style={[styles.diffLine, { color: diffLineColor(theme, line.kind) }]}
                  >
                    {line.text || ' '}
                  </Text>
                ))
                : null}
            </ScrollView>
          </ScrollView>
        </View>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setViewer(null)} visible={viewer !== null}>
        <View style={[styles.viewer, { backgroundColor: theme.surfaceDeep }]}>
          <View style={styles.modalHead}>
            <Text numberOfLines={1} style={[styles.modalTitle, { color: theme.text }]}>
              {viewer?.files[viewerIndex]?.name ?? viewer?.topic ?? ''}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setViewer(null)}>
              <Text style={[styles.backLabel, { color: theme.accent }]}>Done</Text>
            </Pressable>
          </View>
          {viewer && viewer.files[viewerIndex] ? (
            <Image
              resizeMode="contain"
              source={screenshotImageSource(host, viewer.id, viewer.files[viewerIndex])}
              style={styles.viewerImage}
            />
          ) : (
            <View style={styles.viewerImage} />
          )}
          <View style={styles.viewerControls}>
            <Button
              disabled={viewerIndex <= 0}
              label="Previous"
              onPress={() => setViewerIndex((index) => Math.max(0, index - 1))}
              style={styles.viewerButton}
            />
            <Meta>
              {viewer ? `${Math.min(viewerIndex + 1, viewer.files.length)} / ${viewer.files.length}` : ''}
            </Meta>
            <Button
              disabled={!viewer || viewerIndex >= viewer.files.length - 1}
              label="Next"
              onPress={() => setViewerIndex((index) => (
                Math.min((viewer?.files.length ?? 1) - 1, index + 1)
              ))}
              style={styles.viewerButton}
            />
          </View>
        </View>
      </Modal>
    </>
  )
}

export type PaneInfoProps = {
  host: Host
  paneId: string
  brief?: SessionBrief
  status?: AgentStatus
  pane?: TmuxPane
  sessionName?: string
  ports: readonly OpenPort[]
  onClose: () => void
}

/**
 * Screen 05: the Info sections in a sheet pushed over the pane, with a nav row
 * and a chip row that scrolls to each section.
 */
export function PaneInfo({
  host,
  paneId,
  brief,
  status,
  pane,
  sessionName,
  ports,
  onClose,
}: PaneInfoProps): React.JSX.Element {
  const theme = useTheme()
  const scrollRef = useRef<ScrollView>(null)
  const offsets = useRef<Partial<Record<SectionId, number>>>({})
  const [active, setActive] = useState<SectionId>('worklog')

  const worklog = useMemo(() => (brief ? buildWorklogView(brief) : null), [brief])
  const state = worklog?.state ?? status?.status ?? 'unknown'

  const scrollTo = useCallback((section: SectionId) => {
    setActive(section)
    scrollRef.current?.scrollTo({ y: Math.max(0, (offsets.current[section] ?? 0) - 8), animated: true })
  }, [])

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
      <View style={styles.nav}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.back}>
          <Feather color={theme.accent} name="chevron-left" size={18} />
          <Text style={[styles.backLabel, { color: theme.accent }]}>Pane</Text>
        </Pressable>
        <View style={styles.navTitle}>
          <Text numberOfLines={1} style={[styles.navTitleText, { color: theme.text }]}>
            {sessionName ?? brief?.sessionName ?? 'Pane'}
            {status ? ` · ${providerName(status)}` : ''}
          </Text>
          <Text numberOfLines={1} style={[styles.navSubtitle, { color: theme.muted }]}>
            {pane?.repo?.name ? `${pane.repo.name} · ` : ''}
            {pane?.targetId ?? paneId}
            {worklog?.updatedAt || status?.updatedAt
              ? ` · updated ${relativeTime(worklog?.updatedAt ?? status?.updatedAt) || 'now'}`
              : ''}
          </Text>
        </View>
        <Pill label={statusLabel(state)} tone={statusTone(state)} />
      </View>

      <ScrollView
        contentContainerStyle={styles.chipsRow}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
      >
        {SECTION_IDS.map((section) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active === section }}
            key={section}
            onPress={() => scrollTo(section)}
            style={[
              styles.chip,
              {
                backgroundColor: active === section ? theme.surfaceSoft : theme.surface,
                borderColor: active === section ? theme.borderStrong : theme.border,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: active === section ? theme.text : theme.muted }]}>
              {SECTION_LABELS[section]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={styles.body} ref={scrollRef}>
        <PaneInfoSections
          brief={brief}
          host={host}
          onLayoutSection={(section, y) => {
            offsets.current[section] = y
          }}
          pane={pane}
          paneId={paneId}
          ports={ports}
          status={status}
        />
      </ScrollView>
    </View>
  )
}

function providerName(status: AgentStatus): string {
  if (status.provider === 'claude') return 'Claude'
  if (status.provider === 'codex') return 'Codex'
  if (status.provider === 'opencode') return 'OpenCode'
  return 'Shell'
}

function statusTone(state: AgentStatus['status']): 'ok' | 'warn' | 'bad' | 'mute' | 'claude' {
  if (state === 'needs_input') return 'warn'
  if (state === 'failed') return 'bad'
  if (state === 'done') return 'ok'
  if (state === 'working') return 'claude'
  return 'mute'
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function diffLineColor(theme: Theme, kind: ReturnType<typeof parseDiffLines>[number]['kind']): string {
  if (kind === 'added') return theme.green
  if (kind === 'removed') return theme.red
  if (kind === 'hunk') return theme.cyan
  if (kind === 'meta') return theme.muted
  return theme.textSoft
}

function TaskBox({ status }: { status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }): React.JSX.Element {
  const theme = useTheme()
  const done = status === 'completed'
  const running = status === 'in_progress'
  return (
    <View
      style={[
        styles.taskBox,
        {
          backgroundColor: done
            ? theme.green
            : running
              ? withAlpha(theme.accent, 0.2)
              : 'transparent',
          borderColor: done ? theme.green : running ? theme.accent : theme.borderStrong,
        },
      ]}
    >
      {done ? <Text style={styles.taskTick}>✓</Text> : null}
    </View>
  )
}

function TimelineRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const theme = useTheme()
  const [background, color] = kindColors(theme, entry.kind)
  return (
    <View style={styles.timelineRow}>
      <View style={[styles.kindBadge, { backgroundColor: background }]}>
        <Text style={[styles.kindLabel, { color }]}>{UPDATE_KIND_LABEL[entry.kind]}</Text>
      </View>
      <View style={styles.timelineText}>
        <Text style={[styles.timelineHeadline, { color: theme.textSoft }]}>{entry.text}</Text>
        {entry.detail ? (
          <Text style={[styles.timelineDetail, { color: theme.muted }]}>{entry.detail}</Text>
        ) : null}
        <Text style={[styles.timelineMeta, { color: theme.textDim }]}>{entry.author}</Text>
      </View>
      <Text style={[styles.timelineAge, { color: theme.textDim }]}>{relativeTime(entry.createdAt)}</Text>
    </View>
  )
}

function kindColors(theme: Theme, kind: TimelineEntry['kind']): [string, string] {
  switch (kind) {
    case 'check':
      return [withAlpha(theme.cyan, 0.14), theme.cyan]
    case 'decision':
      return [withAlpha(theme.accent, 0.16), theme.accent]
    case 'changed':
      return [withAlpha(theme.green, 0.14), theme.green]
    case 'blocker':
      return [withAlpha(theme.red, 0.14), theme.red]
    case 'screenshots':
      return [withAlpha(theme.amber, 0.14), theme.amber]
    default:
      return [theme.surfaceSoft, theme.muted]
  }
}

/** The recap, rendered from the blocks `parseMarkdown` produced. */
function Markdown({ blocks }: { blocks: readonly MarkdownBlock[] }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={styles.markdown}>
      {blocks.map((block, index) => {
        const spans = block.spans.map((span, spanIndex) => (
          <Text
            key={`${spanIndex}-${span.text.slice(0, 8)}`}
            style={[
              span.bold ? styles.bold : null,
              span.code ? [styles.mono, { color: theme.cyan }] : null,
            ]}
          >
            {span.text}
          </Text>
        ))
        if (block.kind === 'heading') {
          return (
            <Text key={index} style={[styles.markdownHeading, { color: theme.text }]}>
              {spans}
            </Text>
          )
        }
        if (block.kind === 'bullet') {
          return (
            <View key={index} style={styles.bulletRow}>
              <Text style={[styles.bulletMark, { color: theme.muted }]}>{block.ordinal ?? '•'}</Text>
              <Text style={[styles.markdownText, { color: theme.textSoft }]}>{spans}</Text>
            </View>
          )
        }
        return (
          <Text key={index} style={[styles.markdownText, { color: theme.textSoft }]}>
            {spans}
          </Text>
        )
      })}
    </View>
  )
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 8 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  back: { flexDirection: 'row', alignItems: 'center' },
  backLabel: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, minWidth: 0 },
  navTitleText: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  navSubtitle: { fontSize: 12 },
  chips: { flexGrow: 0 },
  chipsRow: { paddingHorizontal: 16, gap: 6, paddingBottom: 8 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  chipLabel: { fontSize: 12.5, fontWeight: '600' },
  body: { paddingHorizontal: 16, paddingBottom: 48, gap: 14 },
  section: { gap: 8 },
  headlineCard: { gap: 8 },
  headlineRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  headlineDot: { paddingTop: 6 },
  headlineText: { flex: 1, gap: 2 },
  headline: { fontSize: 16, fontWeight: '700', lineHeight: 21 },
  headlineMeta: { fontSize: 12 },
  hudActivity: { fontSize: 13.5, lineHeight: 19 },
  chipCluster: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  nextRow: { borderTopWidth: 1, paddingTop: 8, gap: 2 },
  nextLabel: { fontSize: 12, fontWeight: '600' },
  nextValue: { fontSize: 13.5, lineHeight: 19 },
  markdown: { gap: 6 },
  markdownText: { fontSize: 13.5, lineHeight: 19, flex: 1 },
  markdownHeading: { fontSize: 14.5, fontWeight: '700' },
  bulletRow: { flexDirection: 'row', gap: 8 },
  bulletMark: { fontSize: 13.5, lineHeight: 19 },
  bold: { fontWeight: '700' },
  mono: { fontFamily: mono, fontSize: 12.5 },
  tasks: { gap: 6 },
  task: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  taskBox: {
    width: 16,
    height: 16,
    borderRadius: 5,
    borderWidth: 1.5,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTick: { fontSize: 10, color: '#0a1c14', fontWeight: '800' },
  taskLabel: { fontSize: 14, lineHeight: 19, flex: 1 },
  taskDone: { textDecorationLine: 'line-through' },
  timeline: { gap: 8 },
  timelineRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  kindBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginTop: 1 },
  kindLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  timelineText: { flex: 1, gap: 2 },
  timelineHeadline: { fontSize: 13, lineHeight: 18 },
  timelineDetail: { fontSize: 12, lineHeight: 17 },
  timelineMeta: { fontSize: 11 },
  timelineAge: { fontSize: 12 },
  files: { gap: 6 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 12.5, fontFamily: mono },
  fileDir: { fontSize: 11, fontFamily: mono },
  fileStat: { fontSize: 11.5, fontFamily: mono },
  prCard: { gap: 6 },
  prHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prNumber: { fontSize: 12, fontFamily: mono },
  prTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  portRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  portText: { flex: 1 },
  portNumber: { fontSize: 15, fontWeight: '600', fontFamily: mono },
  portProcess: { fontSize: 12 },
  portButton: { paddingVertical: 8, paddingHorizontal: 12, minHeight: 36 },
  folder: { gap: 6 },
  folderTopic: { fontSize: 13, fontWeight: '600' },
  thumbs: { flexDirection: 'row', gap: 8 },
  thumb: { width: 108, height: 72, borderRadius: 10, borderWidth: 1 },
  empty: { fontSize: 13 },
  modal: { flex: 1, paddingTop: 52 },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  modalTitle: { flex: 1, fontSize: 14, fontWeight: '600', fontFamily: mono },
  diffBody: { paddingHorizontal: 16, paddingBottom: 40 },
  diffLine: { fontFamily: mono, fontSize: 11.5, lineHeight: 16 },
  viewer: { flex: 1, paddingTop: 52 },
  viewerImage: { flex: 1, width: '100%' },
  viewerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  viewerButton: { minWidth: 110 },
})
