import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
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
import * as Haptics from 'expo-haptics'

import type { AgentInteractionRequest, AgentQuestion, AgentStatus } from '@commando/protocol'

import {
  answersAreComplete,
  answerErrorText,
  buildPermissionAnswer,
  buildQuestionAnswer,
  buildRejectAnswer,
  emptySelections,
  isOptionSelected,
  sendAgentAnswer,
  toggleOption,
  type PermissionDecision,
  type QuestionSelection,
} from '../answers'
import { useDaemonConnection } from '../daemon/useDaemonConnection'
import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { relativeTime } from '../time'
import { Button, Card, Meta, Pill, ProviderPill, withAlpha } from './primitives'

type AnswerParams = {
  hostId: string
  paneId: string
  interactionId: string
  /** `notification` when the screen was opened by a push action or tap. */
  from?: string
}

/**
 * Screen 04. The request itself comes from the agent status the daemon already
 * broadcasts (`AgentStatus.details.requests`); answering goes out over
 * `answer_agent_request`, or the HTTP answer route when no socket is up.
 */
export function AnswerScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, paneId, interactionId, from } = useLocalSearchParams<AnswerParams>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const status = paneId ? state.agentStatuses[paneId] : undefined
  const request = status?.details?.requests?.find((candidate) => candidate.id === interactionId)

  const sessionName = useMemo(() => {
    const pane = state.snapshot?.panes.find((candidate) => candidate.id === paneId)
    const session = state.snapshot?.sessions.find((candidate) => candidate.id === pane?.sessionId)
    return session?.name ?? status?.agentSessionName ?? 'pane'
  }, [state.snapshot, paneId, status])

  // The request leaves the store the instant the daemon accepts the answer, so
  // the "no longer pending" card must not flash while we are navigating away.
  const answered = useRef(false)

  const openPane = useCallback((replace: boolean): void => {
    const target = {
      pathname: '/(host)/[hostId]/pane/[paneId]' as const,
      params: { hostId: hostId ?? '', paneId: paneId ?? '' },
    }
    if (replace) router.replace(target)
    else router.push(target)
  }, [hostId, paneId, router])

  const leaveAfterAnswer = useCallback((): void => {
    answered.current = true
    if (from === 'notification') {
      router.replace({ pathname: '/(host)/[hostId]/sessions', params: { hostId: hostId ?? '' } })
      return
    }
    if (router.canGoBack()) router.back()
    else openPane(true)
  }, [from, hostId, openPane, router])

  if (!request) {
    return (
      <AnswerFrame
        onShowPane={() => openPane(false)}
        sessionName={sessionName}
        subtitle={paneId ?? ''}
        title={answered.current ? 'Answered' : 'Nothing to answer'}
      >
        <Card raised style={styles.card}>
          <Text style={[styles.gone, { color: theme.text }]}>
            {answered.current
              ? 'The daemon took the answer and released the agent.'
              : 'This request was already answered, or it timed out and is no longer pending.'}
          </Text>
          <Meta>
            {state.phase === 'live'
              ? 'The daemon holds an agent hook open for ten minutes; after that the agent moves on.'
              : state.detail}
          </Meta>
          <Button label={`Show ${sessionName}`} onPress={() => openPane(true)} />
        </Card>
      </AnswerFrame>
    )
  }

  return (
    <AnswerFrame
      onShowPane={() => openPane(false)}
      sessionName={sessionName}
      subtitle={`${paneId} · asked ${relativeTime(request.createdAt) || 'now'}`}
      title={request.kind === 'permission'
        ? `${providerName(status?.provider)} wants permission`
        : `${providerName(status?.provider)} is asking`}
    >
      <AnswerCards
        detail={state.detail}
        host={host}
        live={state.phase === 'live'}
        onAnswered={leaveAfterAnswer}
        paneId={paneId ?? ''}
        request={request}
        sessionName={sessionName}
        status={status}
      />
    </AnswerFrame>
  )
}

export type AnswerCardsProps = {
  host: Host | undefined
  paneId: string
  request: AgentInteractionRequest
  status: AgentStatus | undefined
  sessionName: string
  /** Whether the socket is up; an answer falls back to the HTTP route if not. */
  live: boolean
  /** The connection detail line, shown when the socket is down. */
  detail: string
  /** Called once the daemon has taken the answer. */
  onAnswered: () => void
}

/**
 * The cards themselves: one per `AgentQuestion` with its options and custom
 * field, or the permission's tool and prompt over Allow once / Always / Deny,
 * plus the note field, the actions and any error.
 *
 * Screen 04 wraps these in its own nav; the iPad cockpit puts them at the top
 * of the HUD column and answers the focused pane's request in place.
 */
export function AnswerCards({
  host,
  paneId,
  request,
  status,
  sessionName,
  live,
  detail,
  onAnswered,
}: AnswerCardsProps): React.JSX.Element {
  const theme = useTheme()
  const questions = useMemo(() => request.questions ?? [], [request])
  const interactionId = request.id

  const [selections, setSelections] = useState<QuestionSelection[]>(() => emptySelections(questions))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'answer' | 'reject' | PermissionDecision | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelections(emptySelections(questions))
    setNote('')
    setError(null)
  }, [interactionId, questions])

  const send = useCallback(async (
    kind: 'answer' | 'reject' | PermissionDecision,
  ): Promise<void> => {
    if (!host || !paneId || !interactionId) return
    const answer = kind === 'answer'
      ? buildQuestionAnswer(questions, selections, note)
      : kind === 'reject'
        ? buildRejectAnswer()
        : buildPermissionAnswer(kind)

    setBusy(kind)
    setError(null)
    const result = await sendAgentAnswer({ host, paneId, interactionId, answer })
    setBusy(null)
    if (!result.ok) {
      setError(answerErrorText(result.code, result.message))
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      return
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    onAnswered()
  }, [host, interactionId, note, onAnswered, paneId, questions, selections])

  const permission = request.kind === 'permission'

  return (
    <>
      {permission ? (
        <Card raised style={styles.card}>
          <View style={styles.cardHead}>
            <Pill label="Permission" tone="bad" />
            {status ? <ProviderPill provider={status.provider} /> : null}
            <Meta style={styles.counter}>
              {sessionName} · {relativeTime(request.createdAt) || 'now'}
            </Meta>
          </View>
          {request.toolName ? (
            <Text style={[styles.toolName, { color: theme.text }]}>Run {request.toolName}</Text>
          ) : null}
          <Text
            selectable
            style={[
              styles.command,
              { backgroundColor: theme.terminalBg, color: theme.textSoft, borderColor: theme.border },
            ]}
          >
            {request.prompt}
          </Text>
          <View style={styles.permissionRow}>
            <Button
              busy={busy === 'allow_once'}
              disabled={busy !== null}
              label="Allow once"
              onPress={() => void send('allow_once')}
              style={styles.permissionButton}
              variant="primary"
            />
            <Button
              busy={busy === 'allow_always'}
              disabled={busy !== null}
              label="Always"
              onPress={() => void send('allow_always')}
              style={styles.permissionButton}
            />
            <Button
              busy={busy === 'deny'}
              disabled={busy !== null}
              label="Deny"
              onPress={() => void send('deny')}
              style={styles.permissionButton}
              variant="danger"
            />
          </View>
        </Card>
      ) : (
        <>
          {questions.map((question, index) => (
            <QuestionCard
              count={questions.length}
              index={index}
              key={`${question.header}-${index}`}
              onToggle={(optionIndex) => {
                void Haptics.selectionAsync()
                setSelections((current) => current.map((selection, position) => (
                  position === index ? toggleOption(question, selection, optionIndex) : selection
                )))
              }}
              onCustomChange={(value) => {
                setSelections((current) => current.map((selection, position) => (
                  position === index ? { ...selection, custom: value } : selection
                )))
              }}
              provider={status ? <ProviderPill provider={status.provider} /> : null}
              question={question}
              selection={selections[index] ?? { optionIndices: [], custom: '' }}
            />
          ))}

          {questions.length === 0 ? (
            <Card raised style={styles.card}>
              <Text style={[styles.question, { color: theme.text }]}>{request.prompt}</Text>
              <Meta>This request carries no options; reject it or answer it from the pane.</Meta>
            </Card>
          ) : null}

          <Card style={styles.card}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>NOTE FOR THE AGENT</Text>
            <TextInput
              multiline
              onChangeText={setNote}
              placeholder="Optional"
              placeholderTextColor={theme.textDim}
              style={[
                styles.input,
                styles.noteInput,
                { backgroundColor: theme.surfaceSoft, borderColor: theme.border, color: theme.text },
              ]}
              value={note}
            />
            <Meta>
              The protocol has no note field, so a note is appended to the answer you picked.
            </Meta>
          </Card>

          <View style={styles.actions}>
            <Button
              busy={busy === 'answer'}
              disabled={busy !== null || !answersAreComplete(questions, selections)}
              label="Answer"
              onPress={() => void send('answer')}
              style={styles.answerButton}
              variant="primary"
            />
            <Button
              busy={busy === 'reject'}
              disabled={busy !== null}
              label="Reject"
              onPress={() => void send('reject')}
            />
          </View>
        </>
      )}

      {error ? (
        <Card style={[styles.card, { borderColor: withAlpha(theme.red, 0.4) }]}>
          <Text style={[styles.error, { color: theme.red }]}>{error}</Text>
        </Card>
      ) : null}

      {live ? null : <Meta>{detail} · the answer will go over the HTTP route instead.</Meta>}
    </>
  )
}

function providerName(provider: string | undefined): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return 'The agent'
}

function AnswerFrame({
  title,
  subtitle,
  sessionName,
  onShowPane,
  children,
}: {
  title: string
  subtitle: string
  sessionName: string
  onShowPane: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.nav, { borderBottomColor: theme.border }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : onShowPane())}
          style={styles.navBack}
        >
          <Feather color={theme.accent} name="chevron-left" size={18} />
          <Text numberOfLines={1} style={[styles.navBackLabel, { color: theme.accent }]}>
            {sessionName}
          </Text>
        </Pressable>
        <View style={styles.navTitle}>
          <Text numberOfLines={1} style={[styles.navTitleText, { color: theme.text }]}>{title}</Text>
          <Text numberOfLines={1} style={[styles.navSubtitle, { color: theme.muted }]}>{subtitle}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onShowPane}>
          <Text style={[styles.navAction, { color: theme.muted }]}>Show pane</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  )
}

function QuestionCard({
  question,
  selection,
  index,
  count,
  provider,
  onToggle,
  onCustomChange,
}: {
  question: AgentQuestion
  selection: QuestionSelection
  index: number
  count: number
  provider: React.ReactNode
  onToggle: (optionIndex: number) => void
  onCustomChange: (value: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <Card raised style={styles.card}>
      <View style={styles.cardHead}>
        <Pill label="Question" tone="warn" />
        {provider}
        <Meta style={styles.counter}>{index + 1} of {count}</Meta>
      </View>
      {question.header ? (
        <Text style={[styles.header, { color: theme.muted }]}>{question.header.toUpperCase()}</Text>
      ) : null}
      <Text style={[styles.question, { color: theme.text }]}>{question.question}</Text>
      <View style={styles.options}>
        {question.options.map((option, optionIndex) => {
          const selected = isOptionSelected(selection, optionIndex)
          return (
            <Pressable
              accessibilityRole={question.multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: selected, selected }}
              key={`${option.label}-${optionIndex}`}
              onPress={() => onToggle(optionIndex)}
              style={[
                styles.option,
                {
                  backgroundColor: selected ? withAlpha(theme.accent, 0.1) : theme.surface,
                  borderColor: selected ? theme.accent : theme.border,
                },
              ]}
            >
              <View
                style={[
                  styles.marker,
                  {
                    borderRadius: question.multiple ? 5 : 9,
                    borderColor: selected ? theme.accent : theme.borderStrong,
                  },
                ]}
              >
                {selected ? (
                  <View
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: question.multiple ? 2 : 5,
                      backgroundColor: theme.accent,
                    }}
                  />
                ) : null}
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionLabel, { color: theme.text }]}>{option.label}</Text>
                {option.description ? (
                  <Text style={[styles.optionDescription, { color: theme.muted }]}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )
        })}
      </View>
      {question.custom ? (
        <TextInput
          onChangeText={onCustomChange}
          placeholder="Or type your own answer…"
          placeholderTextColor={theme.textDim}
          style={[
            styles.input,
            { backgroundColor: theme.surfaceSoft, borderColor: theme.border, color: theme.text },
          ]}
          value={selection.custom}
        />
      ) : null}
      {question.multiple ? <Meta>Pick as many as apply.</Meta> : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBack: { flexDirection: 'row', alignItems: 'center', maxWidth: 110 },
  navBackLabel: { fontSize: 15, flexShrink: 1 },
  navTitle: { flex: 1, alignItems: 'center' },
  navTitleText: { fontSize: 15, fontWeight: '700' },
  navSubtitle: { fontSize: 11.5 },
  navAction: { fontSize: 13 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48, gap: 12 },
  card: { gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  counter: { marginLeft: 'auto' },
  header: { fontSize: 11.5, fontWeight: '700', letterSpacing: 1 },
  question: { fontSize: 19, fontWeight: '700', letterSpacing: -0.2, lineHeight: 24 },
  options: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  marker: {
    width: 18,
    height: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: '600' },
  optionDescription: { fontSize: 12.5, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    minHeight: 44,
  },
  noteInput: { minHeight: 72, textAlignVertical: 'top' },
  fieldLabel: { fontSize: 11.5, fontWeight: '700', letterSpacing: 1 },
  toolName: { fontSize: 16, fontWeight: '700' },
  command: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12.5,
    lineHeight: 18,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  permissionRow: { flexDirection: 'row', gap: 6 },
  permissionButton: { flex: 1, paddingHorizontal: 4 },
  actions: { flexDirection: 'row', gap: 8 },
  answerButton: { flex: 1 },
  gone: { fontSize: 15, lineHeight: 21 },
  error: { fontSize: 13.5, lineHeight: 19 },
})
