import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { WebPanePendingNote, WebPaneSentAnswer } from '@commando/protocol'
import { MAX_RESPONSE_ANSWER, MAX_RESPONSE_NOTE, type RedlinePageQuestion, type RedlinePageResponse } from '@commando/redline-response'

import { useTheme } from '../../theme'
import { Button, withAlpha } from '../../ui/primitives'
import {
  EMPTY_DRAFT,
  draftFromNote,
  pickOption,
  questionOptions,
  responseForQuestion,
  sentAgo,
  sentAnswerLabel,
  type QuestionDraft,
} from './questions'

const same = (a: QuestionDraft, b: QuestionDraft): boolean =>
  a.answer === b.answer && a.note === b.note && a.choices.join('\n') === b.choices.join('\n')

/**
 * One page question answered with native controls — the phone's version of
 * the desktop's `CanvasQuestionControls`. Picking an option queues it at once,
 * as the redline choice control does; text answers and notes queue on the
 * button. A sent or recorded answer shows settled until the owner changes it.
 */
export function QuestionCard({
  question,
  context,
  pending,
  sent,
  recorded,
  busy,
  onQueue,
  onRemove,
  onReveal,
}: {
  question: RedlinePageQuestion
  /** Where the question sits: a canvas note title, or the page it is on. */
  context?: string
  pending?: WebPanePendingNote
  sent?: WebPaneSentAnswer
  /** An answer the agent recorded in canvas.json: the question is settled. */
  recorded?: string
  busy: boolean
  onQueue: (response: RedlinePageResponse) => void
  onRemove: (noteId: number) => void
  onReveal?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const base = pending ? draftFromNote(pending, question) : EMPTY_DRAFT
  const [draft, setDraft] = useState<QuestionDraft>(base)
  const [reopened, setReopened] = useState(false)
  const [noteOpen, setNoteOpen] = useState(Boolean(base.note))
  const pendingIdentity = pending ? `${pending.id}:${pending.revision ?? 1}` : ''
  const lastBase = useRef(base)
  // Follow the queue (a send, an edit in the drawer, the page) unless the owner is mid-edit here.
  useEffect(() => {
    const previous = lastBase.current
    lastBase.current = base
    if (same(draft, previous)) setDraft(base)
    if (base.note) setNoteOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIdentity])

  // A new send settles the card again, even one reopened with Change.
  const sentAt = sent?.sentAt
  useEffect(() => { if (sentAt !== undefined) setReopened(false) }, [sentAt])

  const dirty = !same(draft, base)
  const options = questionOptions(question)
  const queue = (next: QuestionDraft): void => {
    if (next.answer.trim()) onQueue(responseForQuestion(question, next))
  }
  const pick = (option: string): void => {
    if (busy) return
    const next = pickOption(question, draft, option)
    setDraft(next)
    if (next.choices.length > 0) queue(next)
    else if (pending) onRemove(pending.id)
  }

  const settled = !pending && !reopened
    ? sent
      ? `${sentAgo(sent.sentAt)} · ${sentAnswerLabel(sent)}`
      : recorded !== undefined
        ? `Answered · ${recorded}`
        : null
    : null

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: pending ? withAlpha(theme.cyan, 0.5) : theme.border }]}>
      {context ? (
        <Pressable accessibilityRole={onReveal ? 'button' : undefined} disabled={!onReveal} onPress={onReveal}>
          <Text numberOfLines={1} style={[styles.context, { color: theme.cyan }]}>{context}{onReveal ? '  ›' : ''}</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.prompt, { color: theme.text }]}>{question.question}</Text>

      {settled ? (
        <View style={styles.settled}>
          <Text style={[styles.settledText, { color: theme.textSoft }]}>{settled}</Text>
          <Button
            label={recorded !== undefined && !sent ? 'Reopen' : 'Change'}
            onPress={() => setReopened(true)}
            style={styles.small}
          />
        </View>
      ) : (
        <>
          {options.length > 0 ? (
            <View accessibilityRole={question.multiple ? undefined : 'radiogroup'} style={styles.options}>
              {options.map((option) => {
                const picked = draft.choices.includes(option)
                return (
                  <Pressable
                    accessibilityLabel={option}
                    accessibilityRole={question.multiple ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: picked, disabled: busy }}
                    disabled={busy}
                    key={option}
                    onPress={() => pick(option)}
                    style={[
                      styles.option,
                      {
                        backgroundColor: picked ? withAlpha(theme.accent, 0.18) : theme.surfaceSoft,
                        borderColor: picked ? theme.accent : theme.borderMid,
                      },
                    ]}
                  >
                    <Text style={[styles.optionLabel, { color: picked ? theme.text : theme.textSoft }]}>
                      {question.kind === 'rating' ? `${option}/${question.max ?? 5}` : option}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ) : (
            <TextInput
              accessibilityLabel={`Answer: ${question.question}`}
              editable={!busy}
              maxLength={MAX_RESPONSE_ANSWER}
              multiline
              onChangeText={(answer) => setDraft({ ...draft, answer })}
              placeholder="Your answer…"
              placeholderTextColor={theme.textDim}
              style={[styles.input, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text }]}
              value={draft.answer}
            />
          )}

          {noteOpen ? (
            <TextInput
              accessibilityLabel="Note (optional)"
              editable={!busy}
              maxLength={MAX_RESPONSE_NOTE}
              multiline
              onChangeText={(note) => setDraft({ ...draft, note })}
              placeholder="Note (optional)"
              placeholderTextColor={theme.textDim}
              style={[styles.input, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text }]}
              value={draft.note}
            />
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setNoteOpen(true)}>
              <Text style={[styles.link, { color: theme.accent }]}>+ Add note</Text>
            </Pressable>
          )}

          <View style={styles.foot}>
            <Text accessibilityRole="text" style={[styles.status, { color: pending && dirty ? theme.amber : theme.green }]}>
              {pending ? (dirty ? 'Changed since queued' : 'Queued ✓') : ''}
            </Text>
            {reopened && !pending ? (
              <Pressable accessibilityRole="button" onPress={() => { setReopened(false); setDraft(base) }}>
                <Text style={[styles.link, { color: theme.muted }]}>Cancel</Text>
              </Pressable>
            ) : null}
            {options.length === 0 || dirty ? (
              <Button
                busy={busy}
                disabled={!dirty || !draft.answer.trim()}
                label={pending ? 'Update answer' : 'Queue answer'}
                onPress={() => queue(draft)}
                style={styles.small}
                variant="primary"
              />
            ) : null}
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  context: { fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  prompt: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: 40, justifyContent: 'center' },
  optionLabel: { fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, minHeight: 56 },
  link: { fontSize: 13, fontWeight: '600' },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'flex-end' },
  status: { flex: 1, fontSize: 12.5, fontWeight: '600' },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  settledText: { flex: 1, fontSize: 13.5 },
  small: { paddingVertical: 8, paddingHorizontal: 14 },
})
