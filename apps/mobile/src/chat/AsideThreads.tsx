import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useShallow } from 'zustand/react/shallow'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { asideKey, asideReportText, hostTakesAsides, type AsideReport, type ChatAsideAction, type ChatAsideRecord, type ChatImageRef, type ChatState } from '@commando/agent-chat'
import { pendingRequests } from '@commando/chat-timeline'
import type { DaemonClient } from '../daemon/client'
import type { ConnectionPhase } from '../daemon/state'
import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { CHAT_SEND_REFUSAL_MS, useChatChannel } from './channel'
import { useChatStore } from './store'
import { useNow } from './Subagents'

import { ASIDE_REPORT_PROMPT } from './asideReport'

export type ThreadOptions = {
  active?: boolean
  newAside?: boolean
  composerDisabled?: boolean
  onStartAside?: (text: string, images: ChatImageRef[]) => Promise<boolean>
  onOpenReport?: (report: AsideReport) => void
  reportDraft?: { id: number; text: string }
  onReportDraftTaken?: () => void
}
type Report = AsideReport & {
  drafting: boolean
  delivery: 'queue' | 'draft'
  close: boolean
  before: Set<string>
  sessionId?: string
  requestId: string
  error?: string
}
const isSavedAside = (record: ChatAsideRecord) => !record.ephemeral && record.status !== 'discarded'

function Button({ label, onPress, disabled = false, selected, primary = false }: { label: string; onPress: () => void; disabled?: boolean; selected?: boolean; primary?: boolean }) {
  const theme = useTheme()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }} disabled={disabled} onPress={onPress}
    style={[styles.button, { borderColor: selected || primary ? theme.cyan : theme.border, backgroundColor: primary ? theme.cyan : theme.surface, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={{ color: primary ? theme.accentInk : selected ? theme.cyan : theme.textSoft, fontSize: 13 }}>{label}</Text>
  </Pressable>
}

export function AsideSheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const theme = useTheme()
  const insets = useContext(SafeAreaInsetsContext)
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.sheetBackdrop, { paddingTop: (insets?.top ?? 24) + 16 }]}>
      <Pressable accessibilityLabel="Dismiss sheet" accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View testID="aside-sheet" accessibilityViewIsModal accessibilityLabel={title} style={[styles.sheet, { backgroundColor: theme.bg, paddingBottom: insets?.bottom ?? 24 }]}>
        <View testID="aside-sheet-header" style={[styles.row, styles.sheetHeader]}><Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>{title}</Text><Button label="Cancel" onPress={onClose} /></View>
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetScroll} contentContainerStyle={styles.sheetBody}>{children}</ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>
}

export function threadStatus(chat?: ChatState): 'running' | 'idle' | 'needs answer' | 'stopped-error' {
  if (!chat || chat.session.status === 'error' || chat.session.status === 'closed') return 'stopped-error'
  if (pendingRequests(chat.items).length || chat.session.status === 'waiting') return 'needs answer'
  return chat.session.status === 'running' || chat.session.status === 'starting' ? 'running' : 'idle'
}
function ThreadChip({ title, chat, selected, onPress, main = false }: { main?: boolean; title: string; chat?: ChatState; selected: boolean; onPress: () => void }) {
  const theme = useTheme()
  const accent = main ? theme.accent : theme.cyan
  const status = threadStatus(chat)
  const color = status === 'running' ? accent : status === 'needs answer' ? theme.amber : status === 'stopped-error' ? theme.red : theme.green
  return <Pressable accessibilityRole="tab" accessibilityLabel={`${title}, ${status}`} accessibilityState={{ selected }} onPress={onPress}
    style={[styles.button, styles.row, { borderColor: selected ? accent : theme.border, backgroundColor: theme.surface }]}>
    <View accessibilityLabel={status} style={[styles.dot, { backgroundColor: color }]} /><Text numberOfLines={1} style={{ color: theme.textSoft, maxWidth: 180 }}>{title}</Text>
  </Pressable>
}
export function AsideTabs({ main, chats, selected, onSelect, onAction, disabled }: {
  main: ChatState; chats: Record<string, ChatState>; selected?: string; onSelect: (id?: string) => void
  onAction: (action: ChatAsideAction) => Promise<boolean>; disabled: boolean
}) {
  const [closedVisible, setClosedVisible] = useState(false)
  const theme = useTheme()
  const asides = main.asides?.filter(isSavedAside) ?? []
  const closed = asides.filter((record) => record.status === 'closed' || record.status === 'promoted')
  return <View>
    {main.asidesError ? <Text accessibilityRole="alert" style={[styles.note, { color: theme.red }]}>Saved asides couldn't be read: {main.asidesError}</Text> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Chat threads" keyboardShouldPersistTaps="handled" style={styles.strip} contentContainerStyle={styles.row}>
      <ThreadChip main title="Main" chat={main} selected={!selected} onPress={() => onSelect()} />
      {asides.filter((record) => record.status === 'open').map((record) => {
        const chat = chats[asideKey(main.paneId, record.id)]
        return <ThreadChip key={record.id} title={chat?.session.title || record.title} chat={chat} selected={selected === record.id} onPress={() => onSelect(record.id)} />
      })}
      {selected === 'new' ? <Button label="New aside" selected onPress={() => onSelect('new')} /> : null}
      <Button label="+ Aside" disabled={disabled} onPress={() => onSelect('new')} />
      {closed.length ? <Button label={`Closed (${closed.length})`} onPress={() => setClosedVisible(true)} /> : null}
    </ScrollView>
    {closedVisible ? <AsideSheet title="Closed asides" onClose={() => setClosedVisible(false)}>
      {closed.map((record) => <View key={record.id} style={styles.section}>
        <Text style={{ color: theme.text }}>{record.title}</Text>
        {record.lastError ? <Text style={{ color: theme.red }}>{record.lastError}</Text> : null}
        {record.status === 'promoted' ? <Text style={{ color: theme.muted }}>Opened as chat</Text>
          : <Button label={`Reopen ${record.title}`} disabled={disabled} onPress={() => { void onAction({ action: 'reopen', asideId: record.id }).then((ok) => { if (ok) setClosedVisible(false) }) }} />}
      </View>)}
    </AsideSheet> : null}
  </View>
}

function AsideBanner({ aside, disabled, reportDisabled, onAction, onReport }: {
  aside: ChatAsideRecord; disabled: boolean; reportDisabled: boolean; onAction: (action: ChatAsideAction) => Promise<boolean>; onReport: () => void
}) {
  const theme = useTheme()
  const [actions, setActions] = useState(false)
  const now = useNow(true)
  const minutes = Math.max(0, Math.floor((now - aside.createdAt) / 60_000))
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
  const mode = aside.mode === 'inherit' ? 'Full access' : aside.readOnlyEnforced ? 'Read-only' : 'Read-only (advisory)'
  const act = (action: ChatAsideAction) => { setActions(false); void onAction(action) }
  return <View style={[styles.banner, { borderColor: withAlpha(theme.cyan, 0.3), backgroundColor: withAlpha(theme.cyan, 0.08) }]}>
    <Text style={{ color: theme.cyan, flex: 1 }}>Aside · forked from Main {age} · {mode}</Text>
    <Button label="Aside actions" onPress={() => setActions(true)} />
    {actions ? <AsideSheet title="Aside actions" onClose={() => setActions(false)}>
      <Button label={aside.mode === 'read-only' ? 'Allow edits' : 'Make read-only'} disabled={disabled} onPress={() => act({ action: 'mode', asideId: aside.id, mode: aside.mode === 'read-only' ? 'inherit' : 'read-only' })} />
      <Button label="Refork" disabled={disabled} onPress={() => {
        setActions(false)
        Alert.alert('Refork aside?', "Replaces this aside's conversation with a fresh fork of Main's latest finished turn.", [
          { text: 'Cancel', style: 'cancel' }, { text: 'Refork', style: 'destructive', onPress: () => { void onAction({ action: 'refork', asideId: aside.id }) } },
        ])
      }} />
      <Button label="Close aside" disabled={disabled} onPress={() => act({ action: 'close', asideId: aside.id })} />
      <Button label="Report to Main" disabled={reportDisabled || disabled} onPress={() => { setActions(false); onReport() }} />
    </AsideSheet> : null}
  </View>
}

/** Hide a thread without losing its channel's pending sends or its composer's recovery drafts. */
function ThreadSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return <View style={[styles.root, !active && styles.hiddenThread]} accessibilityElementsHidden={!active}
    importantForAccessibility={active ? 'auto' : 'no-hide-descendants'} pointerEvents={active ? 'auto' : 'none'}>{children}</View>
}

/** Owns selection, visited threads and reports, just as the web's ChatPane does. */
export function AsideThreads({ host, main, client, phase, renderThread }: {
  host: Host; main: ChatState; client?: DaemonClient; phase: ConnectionPhase
  renderThread: (chat: ChatState, options: ThreadOptions) => ReactNode
}) {
  const theme = useTheme()
  const chats = useChatStore(useShallow((state) => Object.fromEntries(
    Object.entries(state.byHost[host.id] ?? {}).filter(([key]) => key.startsWith(`${main.paneId}~`)),
  )))
  const available = hostTakesAsides(main.session)
  const [selection, setSelection] = useState<string>()
  const selected = available ? selection : undefined
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const awaitingRecord = useRef<string | undefined>(undefined)
  const seenRecord = useRef<string | undefined>(undefined)
  const [error, setError] = useState<string>()
  // Keep an initial snapshot too: a temporarily missing stream must not unmount a pending send.
  const [visited, setVisited] = useState<ChatState[]>([])
  const [report, setReport] = useState<Report>()
  const [draft, setDraft] = useState<{ id: number; text: string }>()
  const sequence = useRef(0)
  const sentReports = useRef(new Map<string, { text: string; at: number }>())
  const { channel, sendError } = useChatChannel(client, main.paneId)
  const reportKey = report ? asideKey(main.paneId, report.asideId) : undefined
  // This channel survives tab switches along with the report sheet.
  const { channel: reportChannel, sendError: reportError } = useChatChannel(client, reportKey)
  const record = main.asides?.find((entry) => entry.id === selected && isSavedAside(entry) && entry.status === 'open')
  const chat = record ? chats[asideKey(main.paneId, record.id)] : undefined
  const isOpen = (thread: ChatState) => main.asides?.some((entry) => asideKey(main.paneId, entry.id) === thread.paneId && isSavedAside(entry) && entry.status === 'open')
  const threads = visited.filter(isOpen)
  if (chat && !threads.some((thread) => thread.paneId === chat.paneId)) threads.push(chat)
  useEffect(() => {
    setVisited((current) => {
      const next = current.filter(isOpen)
      if (chat && !next.some((thread) => thread.paneId === chat.paneId)) next.push(chat)
      return next.length === current.length && next.every((thread, index) => thread === current[index]) ? current : next
    })
  }, [main.asides, chat])
  const connected = phase === 'live' && main.hostConnected
  const disabled = busy || !connected || Boolean(main.session.claudeCodeSwitch) || main.session.status === 'closed' || main.session.status === 'error'
  const addDraft = (text: string) => setDraft((current) => ({ id: ++sequence.current, text: [current?.text, text].filter(Boolean).join('\n\n') }))
  useEffect(() => {
    for (const { requestId } of sendError?.refused ?? []) {
      const sent = sentReports.current.get(requestId)
      if (!sent) continue
      sentReports.current.delete(requestId)
      addDraft(sent.text)
      setSelection(undefined)
      setError(`${sendError?.message}. The report was restored to Main's composer.`)
    }
  }, [sendError])
  useEffect(() => {
    if (record) { seenRecord.current = record.id; awaitingRecord.current = undefined }
    else if (selected && !busy && (main.asides?.some((entry) => entry.id === selected && (!isSavedAside(entry) || entry.status !== 'open')) || (awaitingRecord.current !== selected && seenRecord.current === selected))) setSelection(undefined)
  }, [main.asides, selected, busy, record])

  const request = async (action: ChatAsideAction): Promise<boolean> => {
    if (!channel || disabled || lock.current) return false
    lock.current = true
    setBusy(true); setError(undefined)
    try {
      const result = await channel.aside(action)
      if (!result.ok) { setError(result.error || 'The aside operation failed'); return false }
      if (action.action === 'open' || action.action === 'reopen') {
        const id = result.asideId ?? (action.action === 'reopen' ? action.asideId : undefined)
        awaitingRecord.current = id
        setSelection(id)
      }
      if (action.action === 'close') {
        setSelection((current) => current === action.asideId ? undefined : current)
        setVisited((current) => current.filter((thread) => thread.paneId !== asideKey(main.paneId, action.asideId)))
      }
      return true
    } finally { lock.current = false; setBusy(false) }
  }
  const open = available ? (text: string, images: ChatImageRef[]) => request({ action: 'open', text, ...(images.length ? { images } : {}), mode: 'read-only' }) : undefined
  const startReport = () => {
    if (!record || !chat || !client || chat.session.status !== 'idle' || !chat.hostConnected) return
    // Register the report before sending: a synchronous demo broadcast is still part of this draft.
    setReport({ asideId: record.id, title: chat.session.title || record.title, body: '', drafting: true, delivery: 'queue', close: true,
      before: new Set(chat.items.map((item) => item.id)), sessionId: chat.session.sessionId, requestId: '' })
  }
  useEffect(() => {
    if (!report?.drafting || report.requestId || !reportChannel) return
    const requestId = reportChannel.send(ASIDE_REPORT_PROMPT)
    setReport((current) => current ? { ...current, requestId } : current)
  }, [report, reportChannel])
  useEffect(() => {
    if (!report?.drafting || !report.requestId) return
    const source = reportKey ? chats[reportKey] : undefined
    const refused = reportError?.refused.some((entry) => entry.requestId === report.requestId)
    const fail = (message: string) => setReport((current) => current ? { ...current, drafting: false, error: message } : current)
    if (source?.session.status === 'closed' || source?.session.status === 'error' || (source && source.session.sessionId !== report.sessionId) || refused) {
      fail(refused ? reportError?.message || 'The report prompt was refused' : source?.session.error || 'Drafting stopped. Write the report yourself.')
      return
    }
    if (!connected || !source?.hostConnected) return
    const promptIndex = source.items.findIndex((item) => !report.before.has(item.id) && !item.parentToolUseId && item.kind === 'user_message' && item.text === ASIDE_REPORT_PROMPT)
    const prompt = source.items[promptIndex]
    const replies = prompt ? source.items.slice(promptIndex + 1).filter((item) => item.kind === 'assistant_message' && !item.parentToolUseId && item.turnId === prompt.turnId && !report.before.has(item.id)) : []
    const reply = replies.at(-1)
    const failure = source.items.find((item) => !report.before.has(item.id) && !item.parentToolUseId && item.kind === 'notice' && (item.level === 'error' || item.text === 'Interrupted'))
    if (source.session.status === 'idle' && !failure && reply?.kind === 'assistant_message' && reply.status === 'completed' && reply.text.trim()) {
      setReport((current) => current ? { ...current, drafting: false, body: reply.text } : current)
    }
  }, [chats, connected, report, reportKey, reportError])
  useEffect(() => {
    if (!report?.drafting) return
    const timer = setTimeout(() => setReport((current) => current ? { ...current, drafting: false, error: 'Drafting is taking too long. Write the report yourself.' } : current), 125_000)
    return () => clearTimeout(timer)
  }, [report?.asideId, report?.drafting])
  const deliver = () => {
    if (!report || disabled || report.drafting || !report.body.trim() || !channel) return
    const text = asideReportText(report)
    if (report.delivery === 'draft') addDraft(text)
    else {
      const requestId = channel.send(text, undefined, { delivery: 'queue' })
      for (const [id, sent] of sentReports.current) if (Date.now() - sent.at > CHAT_SEND_REFUSAL_MS) sentReports.current.delete(id)
      sentReports.current.set(requestId, { text, at: Date.now() })
    }
    setReport(undefined)
    setSelection(undefined)
    if (report.close) void request({ action: 'close', asideId: report.asideId })
  }
  const onOpenReport = (source: AsideReport) => {
    const sourceRecord = main.asides?.find((entry) => entry.id === source.asideId && isSavedAside(entry))
    if (sourceRecord?.status === 'open') setSelection(source.asideId)
    else if (sourceRecord?.status === 'closed') Alert.alert(`From aside “${source.title}”`, 'This aside is closed.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Reopen', onPress: () => { void request({ action: 'reopen', asideId: source.asideId }) } },
    ])
    else Alert.alert(`From aside “${source.title}”`, sourceRecord?.status === 'promoted' ? 'Opened as chat' : 'This aside is unavailable.')
  }
  const newChat: ChatState = { ...main, items: [], commands: [], carried: undefined, omittedItems: 0,
    session: { ...main.session, status: 'idle', queue: [], claudeCodeSwitch: undefined, contextUsage: undefined, models: [], permissionMode: undefined } }
  return <View style={styles.root}>
    {available && (main.asides?.some(isSavedAside) || main.asidesError || selected || busy) ? <AsideTabs main={main} chats={chats} selected={selected} onSelect={setSelection} onAction={request} disabled={disabled} /> : null}
    {error ? <View accessibilityRole="alert" style={styles.section}><Text style={{ color: theme.red }}>{error}</Text><Button label="Dismiss aside error" onPress={() => setError(undefined)} /></View> : null}
    {record ? <AsideBanner aside={record} disabled={disabled} reportDisabled={!chat?.hostConnected || chat.session.status !== 'idle' || Boolean(report)} onAction={request} onReport={startReport} /> : null}
    <ThreadSlot active={!selected}>
      {renderThread(main, { active: !selected, onStartAside: open, onOpenReport, reportDraft: draft, onReportDraftTaken: () => setDraft(undefined) })}
    </ThreadSlot>
    {threads.map((initial) => {
      const thread = chats[initial.paneId] ?? initial
      const active = Boolean(chat && chat.paneId === thread.paneId)
      return <ThreadSlot key={thread.paneId} active={active}>{renderThread(thread, { active })}</ThreadSlot>
    })}
    {selected === 'new' ? <>
      <Text style={[styles.note, { color: theme.cyan }]}>New aside · fresh context from Main’s latest finished turn · Read-only</Text>
      {renderThread(newChat, { active: true, newAside: true, composerDisabled: busy, onStartAside: open })}
    </> : selected && !chat ? <View style={styles.section}>
      <Text accessibilityRole="alert" style={{ color: theme.red }}>{record && !busy ? `This aside stopped: ${record.lastError || 'The aside session closed unexpectedly'}` : 'Loading aside…'}</Text>
      {record && !busy ? <Button label="Reopen" disabled={disabled} onPress={() => { void request({ action: 'reopen', asideId: record.id }) }} /> : null}
    </View> : null}
    {report ? <AsideSheet title="Report to Main" onClose={() => setReport(undefined)}>
      <Text style={{ color: theme.muted }}>From aside “{report.title}”</Text>
      {report.error ? <Text accessibilityRole="alert" style={{ color: theme.red }}>{report.error}</Text> : null}
      {report.drafting ? <><Text accessibilityLiveRegion="polite" style={{ color: theme.text }}>{!connected || !chats[asideKey(main.paneId, report.asideId)]?.hostConnected ? 'Waiting for the aside to reconnect…' : 'Drafting…'}</Text><Button label="Write it myself" onPress={() => setReport({ ...report, drafting: false })} /></>
        : <TextInput accessibilityLabel="Report text" multiline value={report.body} onChangeText={(body) => setReport({ ...report, body })} style={[styles.reportInput, { color: theme.text, borderColor: theme.border }]} />}
      <Button label="Queue for Main after its current turn" selected={report.delivery === 'queue'} onPress={() => setReport({ ...report, delivery: 'queue' })} />
      <Button label="Put in Main's composer as a draft" selected={report.delivery === 'draft'} onPress={() => setReport({ ...report, delivery: 'draft' })} />
      <View style={styles.row}><Switch accessibilityLabel="Close aside after sending" value={report.close} onValueChange={(close) => setReport({ ...report, close })} trackColor={{ true: theme.cyan }} /><Text style={{ color: theme.textSoft, flex: 1 }}>Close aside after sending</Text></View>
      <Button label="Send to Main" primary disabled={disabled || report.drafting || !report.body.trim()} onPress={deliver} />
    </AsideSheet> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  hiddenThread: { display: 'none' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9, minHeight: 40 },
  strip: { flexGrow: 0, paddingHorizontal: 12, paddingVertical: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, marginHorizontal: 12, marginVertical: 4, padding: 8 },
  note: { fontSize: 12, padding: 12 },
  section: { padding: 12, gap: 8 },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '100%', flexShrink: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  sheetHeader: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetBody: { padding: 20, gap: 16 },
  heading: { flex: 1, minWidth: 0, flexShrink: 1, fontSize: 18, fontWeight: '600' },
  reportInput: { minHeight: 160, maxHeight: 350, borderWidth: 1, borderRadius: 10, padding: 12, textAlignVertical: 'top', fontSize: 15 },
})
