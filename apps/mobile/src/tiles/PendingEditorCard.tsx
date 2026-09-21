import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { WebPanePendingNote } from '@commando/protocol'

import { useTheme } from '../theme'
import { Button, Pill, withAlpha } from '../ui/primitives'
import {
  editorFor,
  pendingDraftFor,
  pendingItemKind,
  pendingItemLabel,
  selectedChoices,
  toggleChoice,
} from './editor'

export type PendingEditAction = 'save' | 'remove' | 'send'

/**
 * One queued item, with the controls its own kind deserves — the same
 * inference the cockpit's review layer makes, so a rating queued from the page
 * is edited as a rating here too.
 *
 * Save carries the revision the draft opened with: if the page re-answered the
 * same question underneath, the daemon rejects the patch instead of silently
 * overwriting the newer answer.
 */
export function PendingEditorCard({
  note,
  busy,
  onSave,
  onRemove,
  onSend,
}: {
  note: WebPanePendingNote
  busy: boolean
  onSave: (change: { answer: string; note: string }, expectedRevision: number) => void
  onRemove: () => void
  onSend: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const editor = editorFor(note)
  // A pending push replaces the queue whole, so the draft rebases whenever the
  // daemon hands us a new revision of this item.
  const base = useMemo(() => pendingDraftFor(note), [note])
  const [draft, setDraft] = useState(base)

  useEffect(() => {
    setDraft(base)
  }, [base])

  const dirty = draft.answer !== base.answer || draft.note !== base.note

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.header}>
        <Pill label={pendingItemKind(note)} tone={note.response ? 'ok' : 'warn'} />
        <Text numberOfLines={2} style={[styles.label, { color: theme.text }]}>
          {pendingItemLabel(note)}
        </Text>
      </View>

      {note.response ? null : (
        <Text numberOfLines={1} style={[styles.selector, { color: theme.textDim }]}>{note.selector}</Text>
      )}

      {editor.kind === 'choice' ? (
        <View style={styles.options}>
          {editor.options.map((option) => {
            const active = editor.multiple
              ? selectedChoices(draft.answer).includes(option)
              : draft.answer === option
            return (
              <Pressable
                accessibilityRole={editor.multiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: active, selected: active }}
                disabled={busy}
                key={option}
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    answer: editor.multiple
                      ? toggleChoice(current.answer, editor.options, option)
                      : option,
                  }))
                }
                style={[
                  styles.option,
                  {
                    backgroundColor: active ? withAlpha(theme.accent, 0.16) : theme.surfaceRaised,
                    borderColor: active ? theme.accent : theme.border,
                  },
                ]}
              >
                <Text style={[styles.optionLabel, { color: active ? theme.text : theme.muted }]}>
                  {option}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : editor.kind === 'approve' ? (
        <View style={styles.options}>
          {editor.options.map((option) => {
            const active = draft.answer === option
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                disabled={busy}
                key={option}
                onPress={() => setDraft((current) => ({ ...current, answer: option }))}
                style={[
                  styles.option,
                  {
                    backgroundColor: active
                      ? withAlpha(option === 'approve' ? theme.green : theme.amber, 0.16)
                      : theme.surfaceRaised,
                    borderColor: active
                      ? option === 'approve' ? theme.green : theme.amber
                      : theme.border,
                  },
                ]}
              >
                <Text style={[styles.optionLabel, { color: active ? theme.text : theme.muted }]}>
                  {option}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : editor.kind === 'rating' ? (
        <View accessibilityRole="radiogroup" style={styles.options}>
          {Array.from({ length: editor.max }, (_unused, index) => index + 1).map((rating) => {
            const value = `${rating}/${editor.max}`
            const active = draft.answer === value
            return (
              <Pressable
                accessibilityLabel={`${rating} out of ${editor.max}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                disabled={busy}
                key={rating}
                onPress={() => setDraft((current) => ({ ...current, answer: value }))}
                style={[
                  styles.rating,
                  {
                    backgroundColor: active ? withAlpha(theme.accent, 0.16) : theme.surfaceRaised,
                    borderColor: active ? theme.accent : theme.border,
                  },
                ]}
              >
                <Text style={[styles.optionLabel, { color: active ? theme.text : theme.muted }]}>
                  {rating}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={note.response ? 'Answer' : 'Comment'}
          editable={!busy}
          multiline
          onChangeText={(answer) => setDraft((current) => ({ ...current, answer }))}
          placeholderTextColor={theme.textDim}
          style={[
            styles.input,
            { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text },
          ]}
          value={draft.answer}
        />
      )}

      {note.response ? (
        <TextInput
          accessibilityLabel="Optional note"
          editable={!busy}
          multiline
          onChangeText={(value) => setDraft((current) => ({ ...current, note: value }))}
          placeholder="Note (optional)"
          placeholderTextColor={theme.textDim}
          style={[
            styles.input,
            { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text },
          ]}
          value={draft.note}
        />
      ) : null}

      <View style={styles.actions}>
        <Button disabled={busy} label="Remove" onPress={onRemove} style={styles.action} variant="danger" />
        <Button
          disabled={busy || !dirty}
          label="Save"
          onPress={() => onSave({ answer: draft.answer, note: draft.note }, draft.baseRevision)}
          style={styles.action}
        />
        <Button
          busy={busy}
          label="Send this"
          onPress={onSend}
          style={styles.action}
          variant="primary"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  label: { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: '600', lineHeight: 18 },
  selector: { fontSize: 11.5 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  rating: { borderWidth: 1, borderRadius: 10, width: 40, height: 38, alignItems: 'center', justifyContent: 'center' },
  optionLabel: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, minHeight: 60 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, paddingVertical: 10, paddingHorizontal: 8 },
})
