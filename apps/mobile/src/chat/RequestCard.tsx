import { useState } from 'react'
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Haptics from 'expo-haptics'

import type { ChatAnswer, ChatItem } from '@commando/agent-chat'
import { shortPath } from '@commando/chat-timeline'

import { providerPresentation } from '../ui/providerPresentation'
import { useTheme } from '../theme'
import { Button, withAlpha } from '../ui/primitives'

type RequestItem = Extract<ChatItem, { kind: 'request' }>

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/**
 * The oldest open approval or question, answered in place with `chat_answer`
 * (the web composer's ApprovalPanel and QuestionPanel, drawn like the
 * phone's Answer screen). The first answer from any device wins.
 */
export function RequestCard({ request, pendingCount, cwd, disabled, onAnswer, provider }: {
  provider?: string
  request: RequestItem
  pendingCount: number
  cwd: string
  disabled: boolean
  onAnswer: (answer: ChatAnswer) => void
}): React.JSX.Element {
  const theme = useTheme()
  // Buttons stay live, as on the web: the daemon takes the first answer from any device.
  const answer = (value: ChatAnswer) => {
    Keyboard.dismiss()
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onAnswer(value)
  }
  return (
    // A tap outside its buttons puts the keyboard away, since the card can cover the timeline.
    <Pressable
      accessibilityLabel={request.title}
      accessible={false}
      onPress={Keyboard.dismiss}
      style={[styles.card, { backgroundColor: theme.surface, borderColor: withAlpha(theme.amber, 0.45) }]}
      testID="chat-request"
    >
      <View style={styles.head}>
        <Text style={[styles.kicker, { color: theme.amber }]}>
          {request.requestKind === 'question' ? `${providerPresentation(provider).name.toUpperCase()} IS ASKING` : 'PERMISSION REQUEST'}
        </Text>
        {pendingCount > 1 ? <Text style={[styles.count, { color: theme.muted }]}>1/{pendingCount}</Text> : null}
      </View>
      {request.requestKind === 'question'
        ? <Questions request={request} disabled={disabled} onAnswer={answer} />
        : (
            <>
              <Text style={[styles.title, { color: theme.text }]}>{request.title}</Text>
              {request.reason ? <Text selectable style={[styles.reason, { color: theme.textSoft }]}>{shortPath(request.reason, cwd)}</Text> : null}
              {request.detail ? (
                <ScrollView style={[styles.detail, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]} nestedScrollEnabled>
                  <Text selectable style={[styles.detailText, { color: theme.textSoft }]}>{shortPath(request.detail, cwd)}</Text>
                </ScrollView>
              ) : null}
              <View style={styles.row}>
                <Button disabled={disabled} label="Deny" onPress={() => answer({ kind: 'approval', decision: 'deny' })} style={styles.choice} variant="danger" />
                {request.noAlwaysAllow ? null : <Button disabled={disabled} label="Always" onPress={() => answer({ kind: 'approval', decision: 'allow_always' })} style={styles.choice} />}
                <Button disabled={disabled} label="Allow once" onPress={() => answer({ kind: 'approval', decision: 'allow' })} style={styles.choice} variant="primary" />
              </View>
            </>
          )}
    </Pressable>
  )
}

/** AskUserQuestion, after the web's QuestionPanel: options plus a typed answer per question. */
function Questions({ request, disabled, onAnswer }: { request: RequestItem; disabled: boolean; onAnswer: (answer: ChatAnswer) => void }): React.JSX.Element {
  const theme = useTheme()
  const questions = request.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const toggle = (question: string, label: string, multi: boolean) => {
    void Haptics.selectionAsync()
    setSelected((current) => {
      const chosen = current[question] ?? []
      const next = multi ? (chosen.includes(label) ? chosen.filter((value) => value !== label) : [...chosen, label]) : [label]
      return { ...current, [question]: next }
    })
  }
  const answerFor = (question: string) => other[question]?.trim() || (selected[question] ?? []).join(', ')
  const complete = questions.length > 0 && questions.every((question) => answerFor(question.question))
  return (
    <ScrollView style={styles.questions} contentContainerStyle={styles.questionsContent} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {questions.map((question) => {
        const chosen = selected[question.question] ?? []
        return (
          <View key={question.question} style={styles.question}>
            {question.header ? <Text style={[styles.header, { color: theme.muted }]}>{question.header.toUpperCase()}</Text> : null}
            <Text style={[styles.title, { color: theme.text }]}>{question.question}</Text>
            {question.options.map((option) => {
              const active = chosen.includes(option.label)
              return (
                <Pressable
                  accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: active, disabled }}
                  disabled={disabled}
                  key={option.label}
                  onPress={() => toggle(question.question, option.label, question.multiSelect)}
                  style={[styles.option, {
                    backgroundColor: active ? withAlpha(theme.accent, 0.1) : theme.surfaceRaised,
                    borderColor: active ? theme.accent : theme.border,
                  }]}
                >
                  <View style={[styles.marker, { borderRadius: question.multiSelect ? 4 : 8, borderColor: active ? theme.accent : theme.borderStrong }]}>
                    {active ? <View style={[styles.markerFill, { borderRadius: question.multiSelect ? 2 : 4, backgroundColor: theme.accent }]} /> : null}
                  </View>
                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, { color: theme.text }]}>{option.label}</Text>
                    {option.description ? <Text style={[styles.optionDescription, { color: theme.muted }]}>{option.description}</Text> : null}
                  </View>
                </Pressable>
              )
            })}
            <TextInput
              accessibilityLabel={`Or type an answer to: ${question.question}`}
              editable={!disabled}
              onChangeText={(value) => setOther((current) => ({ ...current, [question.question]: value }))}
              placeholder="Or type an answer"
              placeholderTextColor={theme.textDim}
              style={[styles.input, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text }]}
              value={other[question.question] ?? ''}
            />
          </View>
        )
      })}
      <Button
        disabled={disabled || !complete}
        label="Answer"
        onPress={() => onAnswer({ kind: 'question', answers: Object.fromEntries(questions.map((question) => [question.question, answerFor(question.question)])) })}
        variant="primary"
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { flexShrink: 1, minHeight: 0, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 8, marginHorizontal: 12, marginBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center' },
  kicker: { flex: 1, fontSize: 11.5, fontWeight: '700', letterSpacing: 1 },
  count: { fontSize: 12 },
  title: { fontSize: 16, fontWeight: '700', lineHeight: 21 },
  reason: { fontSize: 14, lineHeight: 19 },
  detail: { flexShrink: 1, minHeight: 36, overflow: 'hidden', maxHeight: 120, borderWidth: 1, borderRadius: 10 },
  detailText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 8 },
  row: { flexDirection: 'row', gap: 6 },
  choice: { flex: 1, paddingHorizontal: 4, paddingVertical: 9, minHeight: 40 },
  questions: { flexShrink: 1, maxHeight: 360 },
  questionsContent: { gap: 12 },
  question: { gap: 8 },
  header: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  marker: { width: 16, height: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  markerFill: { width: 8, height: 8 },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: '600' },
  optionDescription: { fontSize: 12.5, lineHeight: 17 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 42 },
})
