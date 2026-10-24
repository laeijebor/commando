import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import { CodeBlock, Markdown } from '../chat/Markdown'
import type { Host } from '../hosts/types'
import { useTheme, type Theme } from '../theme'
import { Button, withAlpha } from '../ui/primitives'
import { buildGuideDocument, deliveryLabel, guideProgress, MAX_GUIDE_NOTE, type CalloutTone, type GuideBlock, type GuideListItem, type GuideStepState, type GuideTile } from './model'
import { useGuide, type GuideController } from './useGuide'

type StepContext = {
  steps: ReadonlyMap<string, GuideStepState>
  busy: ReadonlySet<string>
  toggle: (step: GuideStepState) => void
  saveNote: (step: GuideStepState, note: string) => void
}
const GuideSteps = createContext<StepContext | null>(null)

/** A guide tab drawn natively: its Markdown with every step a large checkbox, notes, and "Update agent". */
export function GuideView({ host, tile, active = true, onTitle }: { host: Host; tile: GuideTile; active?: boolean; onTitle?: (title: string) => void }): React.JSX.Element {
  const guide = useGuide(host, tile.id, tile.content, active)
  // The first H1 names the guide, as the desktop titles its tab.
  const title = guide.snapshot?.title
  useEffect(() => { if (title) onTitle?.(title) }, [title, onTitle])
  return <GuideBody guide={guide} />
}

export function GuideBody({ guide }: { guide: GuideController }): React.JSX.Element {
  const theme = useTheme()
  const { markdown, snapshot } = guide
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])

  const steps = snapshot?.steps ?? []
  // Re-lex only when the file or its step list changes, not on every tick.
  const outlineKey = steps.map((step) => `${step.id}\u0000${step.label}\u0000${step.checkpoint}`).join('\u0001')
  const document = useMemo(() => markdown === null ? null : buildGuideDocument(markdown, steps), [markdown, outlineKey])
  const context = useMemo<StepContext>(() => ({
    steps: new Map(steps.map((step) => [step.id, step])),
    busy: guide.busy,
    toggle: (step) => { void Haptics.selectionAsync(); guide.toggle(step.id, !step.checked) },
    saveNote: (step, note) => guide.saveNote(step.id, note),
  }), [steps, guide.busy, guide.toggle, guide.saveNote])

  const progress = guideProgress(steps)
  const changes = snapshot?.changes.length ?? 0
  const waiting = snapshot?.waiting ?? false
  const delivery = deliveryLabel(snapshot, now)
  const confirmReset = () => Alert.alert('Clear your ticks and notes?', 'Steps the agent marked done stay done.', [
    { style: 'cancel', text: 'Keep them' },
    { style: 'destructive', text: 'Clear', onPress: () => { void guide.reset() } },
  ])

  return (
    <View style={styles.root}>
      <View style={[styles.toolbar, { borderBottomColor: theme.border, backgroundColor: theme.surface }]}>
        <View style={styles.progressRow} accessible accessibilityLabel={progress.total ? `${progress.done} of ${progress.total} steps done` : 'No steps yet'}>
          <Text style={[styles.count, { color: theme.text }]}>{progress.total ? `${progress.done}/${progress.total}` : '—'}</Text>
          <View style={[styles.track, { backgroundColor: theme.surfaceSoft }]}>
            <View style={[styles.fill, { width: `${progress.fraction * 100}%`, backgroundColor: progress.total && progress.done === progress.total ? theme.green : theme.accent }]} />
          </View>
          <Text style={[styles.progressNote, { color: theme.muted }]}>{progress.total ? `${progress.done} of ${progress.total} done` : 'No steps yet'}</Text>
        </View>
        {delivery ? <Text numberOfLines={1} style={[styles.delivery, { color: waiting ? theme.amber : changes ? theme.textSoft : theme.textDim }]}>{delivery}</Text> : null}
      </View>

      {!guide.live ? <Banner tone="amber" icon="wifi-off" text="Offline — showing the guide as last loaded. It refreshes when the host reconnects." /> : null}
      {guide.notice ? (
        <Banner
          tone={guide.notice.kind === 'sent' ? 'green' : guide.notice.kind === 'queued' ? 'amber' : 'muted'}
          icon={guide.notice.kind === 'sent' ? 'check-circle' : guide.notice.kind === 'queued' ? 'clock' : 'x-circle'}
          text={guide.notice.kind === 'sent' ? 'Progress sent to the agent.' : guide.notice.kind === 'queued' ? 'Queued — it sends when the agent is idle.' : 'Update cancelled.'}
        />
      ) : null}
      {guide.error && markdown !== null ? <Banner tone="red" icon="alert-triangle" text={guide.error} /> : null}

      {markdown === null ? (
        <View style={styles.center}>
          {guide.loadError ? (
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Feather name="book-open" size={26} color={theme.red} />
              <Text style={[styles.cardTitle, { color: theme.text }]}>The guide could not be loaded</Text>
              <Text style={[styles.cardBody, { color: theme.muted }]}>{guide.loadError}</Text>
              <Button label="Try again" onPress={guide.reload} />
            </View>
          ) : (
            <View style={styles.loading}><ActivityIndicator color={theme.accent} /><Text style={{ color: theme.muted }}>Loading guide…</Text></View>
          )}
        </View>
      ) : (
        <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.doc}>
          {guide.loadError ? <Banner tone="red" icon="alert-triangle" text={guide.loadError} /> : null}
          {document?.blocks.length ? (
            <GuideSteps.Provider value={context}><Blocks blocks={document.blocks} /></GuideSteps.Provider>
          ) : (
            <Text style={[styles.cardBody, { color: theme.muted }]}>This guide is empty.</Text>
          )}
        </ScrollView>
      )}

      <View style={[styles.actions, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Clear my ticks and notes" disabled={!snapshot} onPress={confirmReset} hitSlop={6}
          style={[styles.resetButton, { borderColor: theme.borderMid, opacity: snapshot ? 1 : 0.5 }]}>
          <Feather name="rotate-ccw" size={17} color={theme.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={waiting ? 'Cancel the queued update' : `Update agent${changes ? ` with ${changes} change${changes === 1 ? '' : 's'}` : ''}`}
          accessibilityState={{ disabled: guide.sending || (!changes && !waiting) }}
          disabled={guide.sending || (!changes && !waiting)}
          onPress={() => { void Haptics.selectionAsync(); void guide.update() }}
          style={[styles.update, {
            backgroundColor: waiting ? theme.surfaceSoft : changes ? theme.accent : theme.surfaceSoft,
            borderColor: waiting || !changes ? theme.borderMid : 'transparent',
            opacity: guide.sending || (!changes && !waiting) ? 0.55 : 1,
          }]}
        >
          {guide.sending ? <ActivityIndicator color={changes && !waiting ? theme.accentInk : theme.text} /> : (
            <>
              <Feather name={waiting ? 'x' : 'send'} size={16} color={changes && !waiting ? theme.accentInk : theme.text} />
              <Text style={[styles.updateLabel, { color: changes && !waiting ? theme.accentInk : theme.text }]}>
                {waiting ? 'Cancel update' : `Update agent${changes ? ` (${changes})` : ''}`}
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  )
}

function Banner({ tone, icon, text }: { tone: 'green' | 'amber' | 'red' | 'muted'; icon: React.ComponentProps<typeof Feather>['name']; text: string }): React.JSX.Element {
  const theme = useTheme()
  const color = tone === 'muted' ? theme.muted : theme[tone]
  return (
    <View accessibilityRole={tone === 'red' ? 'alert' : undefined} style={[styles.banner, { backgroundColor: withAlpha(color, 0.1), borderColor: withAlpha(color, 0.35) }]}>
      <Feather name={icon} size={15} color={color} />
      <Text style={[styles.bannerText, { color: theme.textSoft }]}>{text}</Text>
    </View>
  )
}

const Blocks = memo(function Blocks({ blocks }: { blocks: readonly GuideBlock[] }) {
  return <View style={styles.blocks}>{blocks.map((block) => <Block key={block.key} block={block} />)}</View>
})

function Block({ block }: { block: GuideBlock }): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  switch (block.kind) {
    case 'markdown':
      return <Markdown text={block.text} />
    case 'code':
      return <CopyableCode code={block.code} lang={block.lang} />
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => item.task
            ? <StepRow key={item.key} item={item} />
            : (
              <View key={item.key} style={styles.listItem}>
                <Text style={[styles.marker, { color: theme.muted }]}>{block.ordered ? `${block.start + index}.` : '•'}</Text>
                <View style={styles.listBody}><Blocks blocks={item.body} /></View>
              </View>
            ))}
        </View>
      )
    case 'checkpoint':
      return <CheckpointRow block={block} />
    case 'callout':
      return (
        <View accessibilityRole="summary" style={[styles.callout, { borderLeftColor: toneColor(block.tone, theme), backgroundColor: withAlpha(toneColor(block.tone, theme), 0.08) }]}>
          {block.title ? <Text style={[styles.calloutTitle, { color: theme.text }]}>{block.title}</Text> : null}
          <Blocks blocks={block.body} />
        </View>
      )
    case 'details':
      return (
        <View style={[styles.details, { borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.detailsHead}>
            <Feather name={open ? 'chevron-down' : 'chevron-right'} size={16} color={theme.muted} />
            <Text style={[styles.detailsSummary, { color: theme.textSoft }]}>{block.summary}</Text>
          </Pressable>
          {open ? <View style={styles.detailsBody}><Blocks blocks={block.body} /></View> : null}
        </View>
      )
    case 'quote':
      return <View style={[styles.quote, { borderLeftColor: theme.borderStrong }]}><Blocks blocks={block.body} /></View>
  }
}

function toneColor(tone: CalloutTone, theme: Theme): string {
  return tone === 'warn' ? theme.amber : tone === 'danger' ? theme.red : tone === 'success' ? theme.green : theme.cyan
}

function useStep(stepId: string | undefined): { step?: GuideStepState; context: StepContext | null } {
  const context = useContext(GuideSteps)
  return { step: stepId ? context?.steps.get(stepId) : undefined, context }
}

function Checkbox({ checked, disabled, label, onPress, busy }: { checked: boolean; disabled: boolean; label: string; onPress: () => void; busy?: boolean }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled, busy: Boolean(busy) }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={styles.checkHit}
    >
      <View style={[styles.box, {
        borderColor: checked ? theme.green : theme.borderStrong,
        backgroundColor: checked ? withAlpha(theme.green, 0.18) : theme.surfaceSoft,
        opacity: disabled && !busy ? 0.55 : 1,
      }]}>
        {checked ? <Feather name="check" size={18} color={theme.green} /> : null}
      </View>
    </Pressable>
  )
}

function StepRow({ item }: { item: GuideListItem }): React.JSX.Element {
  const theme = useTheme()
  const { step, context } = useStep(item.stepId)
  const checked = step?.checked ?? item.sourceChecked
  const busy = Boolean(step && context?.busy.has(step.id))
  return (
    <View style={[styles.step, { backgroundColor: checked ? withAlpha(theme.green, 0.05) : 'transparent', borderColor: checked ? withAlpha(theme.green, 0.2) : theme.border }]}>
      <Checkbox checked={checked} busy={busy} disabled={!step || !context || busy} label={step?.label ?? 'Step'} onPress={() => { if (step) context?.toggle(step) }} />
      <View style={[styles.stepBody, checked && styles.done]}>
        <Blocks blocks={item.body} />
        {step ? <StepMeta step={step} /> : null}
      </View>
    </View>
  )
}

function CheckpointRow({ block }: { block: Extract<GuideBlock, { kind: 'checkpoint' }> }): React.JSX.Element {
  const theme = useTheme()
  const { step, context } = useStep(block.stepId)
  const checked = step?.checked ?? block.sourceChecked
  const busy = Boolean(step && context?.busy.has(step.id))
  return (
    <View style={[styles.checkpoint, { borderColor: checked ? withAlpha(theme.green, 0.45) : withAlpha(theme.accent, 0.45), backgroundColor: withAlpha(checked ? theme.green : theme.accent, 0.08) }]}>
      <Checkbox checked={checked} busy={busy} disabled={!step || !context || busy} label={`Checkpoint: ${step?.label ?? block.label}`} onPress={() => { if (step) context?.toggle(step) }} />
      <View style={styles.stepBody}>
        <View style={styles.checkpointHead}>
          <Feather name="flag" size={13} color={checked ? theme.green : theme.accent} />
          <Text style={[styles.checkpointKind, { color: checked ? theme.green : theme.accent }]}>{checked ? 'CHECKPOINT REACHED' : 'CHECKPOINT'}</Text>
        </View>
        <Markdown text={block.label} />
        {step ? <StepMeta step={step} /> : null}
      </View>
    </View>
  )
}

/** "agent" for a step the agent marked done, then the note: shown, edited, or offered. */
function StepMeta({ step }: { step: GuideStepState }): React.JSX.Element {
  const theme = useTheme()
  const context = useContext(GuideSteps)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(step.note ?? '')
  useEffect(() => { if (!editing) setDraft(step.note ?? '') }, [editing, step.note])
  const save = () => {
    setEditing(false)
    if (draft.trim() !== (step.note ?? '')) context?.saveNote(step, draft)
  }
  const byAgent = step.checked && !step.byUser && step.sourceChecked
  // The actions sit above the field: iOS scrolls the caret into view, and the keyboard would cover anything below it.
  if (editing) return (
    <View style={styles.noteEditor}>
      <View style={styles.noteActions}>
        <Text style={[styles.noteHeading, { color: theme.muted }]}>Note</Text>
        <Button label="Cancel" onPress={() => { setDraft(step.note ?? ''); setEditing(false) }} />
        <Button label="Save note" onPress={save} variant="primary" />
      </View>
      <TextInput
        accessibilityLabel={`Note for ${step.label}`}
        autoFocus
        maxLength={MAX_GUIDE_NOTE}
        multiline
        onChangeText={setDraft}
        placeholder="What happened? (sent with the next update)"
        placeholderTextColor={theme.textDim}
        style={[styles.noteInput, { color: theme.text, borderColor: theme.borderStrong, backgroundColor: theme.surfaceSoft }]}
        value={draft}
      />
    </View>
  )
  return (
    <View style={styles.meta}>
      {byAgent ? <Text style={[styles.agentTag, { color: theme.green, backgroundColor: withAlpha(theme.green, 0.12) }]}>agent</Text> : null}
      {step.note ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Edit note: ${step.note}`} onPress={() => setEditing(true)} style={[styles.note, { borderLeftColor: theme.accent, backgroundColor: theme.surfaceSoft }]}>
          <Feather name="message-square" size={13} color={theme.accent} style={styles.noteIcon} />
          <Text style={[styles.noteText, { color: theme.textSoft }]}>{step.note}</Text>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`Add a note to ${step.label}`} hitSlop={8} onPress={() => setEditing(true)} style={styles.addNote}>
          <Feather name="message-square" size={14} color={theme.muted} />
          <Text style={[styles.addNoteText, { color: theme.muted }]}>Add note</Text>
        </Pressable>
      )}
    </View>
  )
}

function CopyableCode({ code, lang }: { code: string; lang?: string | undefined }): React.JSX.Element {
  const theme = useTheme()
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1_500); return () => clearTimeout(timer) }, [copied])
  return (
    <View>
      <CodeBlock code={code} lang={lang} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Copied' : 'Copy'}
        hitSlop={8}
        onPress={() => { void Clipboard.setStringAsync(code).then(() => setCopied(true)).catch(() => undefined) }}
        style={[styles.copy, { backgroundColor: theme.surfaceSoft, borderColor: theme.borderMid }]}
      >
        <Feather name={copied ? 'check' : 'copy'} size={14} color={copied ? theme.green : theme.muted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  toolbar: { paddingHorizontal: 16, paddingVertical: 10, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  count: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 36 },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  progressNote: { fontSize: 12, fontVariant: ['tabular-nums'] },
  delivery: { fontSize: 12 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderRadius: 10 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  loading: { alignItems: 'center', gap: 10 },
  card: { borderWidth: 1, borderRadius: 16, padding: 24, gap: 14, maxWidth: 560, width: '100%', alignSelf: 'center' },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  cardBody: { fontSize: 14, lineHeight: 21 },
  doc: { padding: 16, paddingBottom: 32, gap: 12, maxWidth: 776, width: '100%', alignSelf: 'center' },
  blocks: { gap: 10 },
  list: { gap: 8 },
  listItem: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 16, fontSize: 15, lineHeight: 21 },
  listBody: { flex: 1, minWidth: 0 },
  step: { flexDirection: 'row', gap: 6, borderWidth: 1, borderRadius: 12, paddingVertical: 6, paddingRight: 12 },
  stepBody: { flex: 1, minWidth: 0, paddingTop: 10, paddingBottom: 4, gap: 6 },
  done: { opacity: 0.72 },
  checkHit: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 9 },
  box: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkpoint: { flexDirection: 'row', gap: 6, borderWidth: 1.5, borderRadius: 12, paddingVertical: 6, paddingRight: 12 },
  checkpointHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  checkpointKind: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  agentTag: { fontSize: 11, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  addNote: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 28 },
  addNoteText: { fontSize: 13 },
  note: { flexDirection: 'row', gap: 7, borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 7, flexShrink: 1, flexGrow: 1 },
  noteIcon: { marginTop: 2 },
  noteText: { flex: 1, fontSize: 14, lineHeight: 20 },
  noteEditor: { gap: 8 },
  noteInput: { minHeight: 76, borderWidth: 1, borderRadius: 10, paddingHorizontal: 11, paddingTop: 9, paddingBottom: 9, fontSize: 15, lineHeight: 20, textAlignVertical: 'top' },
  noteActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteHeading: { flex: 1, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  callout: { borderLeftWidth: 3, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  calloutTitle: { fontSize: 14, fontWeight: '700' },
  details: { borderWidth: 1, borderRadius: 10 },
  detailsHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 10 },
  detailsSummary: { fontSize: 14, fontWeight: '600', flex: 1 },
  detailsBody: { paddingHorizontal: 12, paddingBottom: 12 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  copy: { position: 'absolute', top: 6, right: 6, width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  resetButton: { width: 46, height: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  update: { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  updateLabel: { fontSize: 15, fontWeight: '700' },
})
