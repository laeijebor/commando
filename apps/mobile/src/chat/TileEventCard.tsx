import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import {
  autofixSummary,
  readableComment,
  tileEventSummary,
  tileEventTitle,
  type ChatAutofixEvent,
  type ChatCardEvent,
  type ChatTileEvent,
} from '@commando/chat-tile-events'

import { useTheme } from '../theme'

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A card Commando put on the user's side of the chat: an agent opened a
 * redline or canvas, the user sent answers from one, or PR auto-fix asked the
 * agent for a round. The phone's version of the web's TileEventCard and
 * AutofixCard. `onOpenTile` is absent when the tile has closed.
 */
export function ChatEventCard({ event, onOpenTile }: { event: ChatCardEvent; onOpenTile?: ((webPaneId: string) => void) | undefined }): React.JSX.Element {
  return event.kind === 'autofix'
    ? <AutofixCard event={event} />
    : <TileEventCard event={event} {...(onOpenTile ? { onOpen: () => onOpenTile(event.webPaneId) } : {})} />
}

function TileEventCard({ event, onOpen }: { event: ChatTileEvent; onOpen?: () => void }): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const icon = event.source === 'canvas' ? 'layout' : 'edit-3'
  const source = event.source === 'canvas' ? 'Canvas' : 'Redline'
  const title = tileEventTitle(event)
  const openLabel = event.source === 'canvas' ? 'Open canvas' : 'Open page'

  if (event.kind === 'opened') {
    return (
      <View style={[styles.card, styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="tile-event-card">
        <Feather color={theme.muted} name={icon} size={14} />
        <Text numberOfLines={1} style={[styles.headText, { color: theme.textSoft }]}>
          {source} opened · <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        </Text>
        {onOpen ? (
          <Pressable accessibilityLabel={`${openLabel} ${title}`} accessibilityRole="button" hitSlop={8} onPress={onOpen}>
            <Text style={[styles.link, { color: theme.accent }]}>Open</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }

  const items = event.items ?? []
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="tile-event-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={styles.row}
      >
        <Feather color={theme.muted} name={icon} size={14} />
        <View style={styles.headColumn}>
          <Text numberOfLines={1} style={[styles.headText, { color: theme.textSoft }]}>
            {source} on <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
          </Text>
          <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
            {tileEventSummary(items)}{event.build ? ' · build' : ''}
          </Text>
        </View>
        <Status event={event} />
        <Feather color={theme.textDim} name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      </Pressable>
      {open ? (
        <View style={[styles.body, { borderTopColor: theme.border }]}>
          {items.map((item, index) => (
            <View key={index} style={[styles.item, index > 0 && { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
              {item.kind === 'answer' ? (
                <>
                  <Text selectable style={[styles.label, { color: theme.muted }]}>{item.question}</Text>
                  {item.skipped
                    ? <Text style={[styles.skipped, { color: theme.muted }]}>Skipped</Text>
                    : <Text selectable style={[styles.answer, { color: theme.text, backgroundColor: theme.surfaceSoft, borderColor: theme.border }]}>{item.answer}</Text>}
                  {item.note ? <Text selectable style={[styles.note, { color: theme.textSoft, borderLeftColor: theme.border }]}>{item.note}</Text> : null}
                </>
              ) : (
                <>
                  <Text numberOfLines={1} style={[styles.label, { color: theme.muted }]}>Comment on {item.target}</Text>
                  <Text selectable style={[styles.text, { color: theme.text }]}>{item.comment}</Text>
                </>
              )}
              {item.attachments ? (
                <Text style={[styles.meta, { color: theme.muted }]}>{item.attachments === 1 ? '1 image' : `${item.attachments} images`} attached</Text>
              ) : null}
            </View>
          ))}
          <View style={styles.footer}>
            {onOpen ? (
              <Pressable accessibilityRole="button" hitSlop={8} onPress={onOpen}>
                <Text style={[styles.link, { color: theme.accent }]}>{openLabel}</Text>
              </Pressable>
            ) : null}
            <Text style={[styles.meta, styles.footerTime, { color: theme.muted }]}>
              Sent {time(event.at)}{event.collectedAt ? ` · collected ${time(event.collectedAt)}` : ''}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

function Status({ event }: { event: ChatTileEvent }): React.JSX.Element {
  const theme = useTheme()
  if (event.status === 'collected') {
    return (
      <View style={styles.status}>
        <Feather color={theme.green} name="check" size={11} />
        <Text style={[styles.statusText, { color: theme.green }]}>Collected</Text>
      </View>
    )
  }
  if (event.status === 'waiting') return <Text style={[styles.statusText, { color: theme.amber }]}>Waiting for agent</Text>
  return <Text style={[styles.statusText, { color: theme.muted }]}>Sent</Text>
}

function AutofixCard({ event }: { event: ChatAutofixEvent }): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const name = `${event.repo.split('/').at(-1) ?? event.repo}#${event.number}`
  const summary = autofixSummary(event)
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="autofix-card">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.row}>
        <Feather color={theme.muted} name="tool" size={14} />
        <View style={styles.headColumn}>
          <Text numberOfLines={1} style={[styles.headText, { color: theme.textSoft }]}>
            Auto-fix · <Text style={[styles.title, { color: theme.text }]}>{name}</Text>
          </Text>
          {summary ? <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>{summary}</Text> : null}
        </View>
        <Text style={[styles.statusText, { color: theme.muted }]}>Round {event.round}/{event.maxRounds}</Text>
        <Feather color={theme.textDim} name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      </Pressable>
      {open ? (
        <View style={[styles.body, { borderTopColor: theme.border }]}>
          {event.failingChecks.length ? (
            <View style={styles.item}>
              <Text style={[styles.label, { color: theme.muted }]}>Failing checks{event.headSha ? ` on ${event.headSha.slice(0, 7)}` : ''}</Text>
              {event.failingChecks.map((check) => (
                <View key={check} style={styles.check}>
                  <Feather color={theme.red} name="x-circle" size={11} />
                  <Text numberOfLines={1} style={[styles.text, { color: theme.text }]}>{check}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {event.comments.map((comment, index) => (
            <View key={`${comment.url}-${index}`} style={[styles.item, { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
              <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>{comment.author}</Text>
              <Text numberOfLines={6} selectable style={[styles.text, { color: theme.textSoft }]}>{readableComment(comment.body) || '(no text)'}</Text>
            </View>
          ))}
          {event.conflictsWith !== undefined ? (
            <View style={[styles.item, styles.check]}>
              <Feather color={theme.red} name="git-merge" size={11} />
              <Text style={[styles.text, { color: theme.text }]}>Merge conflicts{event.conflictsWith ? ` with ${event.conflictsWith}` : ''}</Text>
            </View>
          ) : null}
          <View style={styles.footer}>
            <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void Linking.openURL(event.url)}>
              <Text style={[styles.link, { color: theme.accent }]}>GitHub</Text>
            </Pressable>
            <Text style={[styles.meta, styles.footerTime, { color: theme.muted }]}>Sent {time(event.at)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { alignSelf: 'flex-end', maxWidth: '88%', minWidth: '60%', borderWidth: 1, borderRadius: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  headColumn: { flex: 1, minWidth: 0, gap: 1 },
  headText: { flexShrink: 1, fontSize: 14 },
  title: { fontWeight: '600' },
  meta: { fontSize: 12 },
  link: { fontSize: 13, fontWeight: '600' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  statusText: { fontSize: 11.5 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingBottom: 10 },
  item: { paddingVertical: 7, gap: 3 },
  label: { fontSize: 12 },
  answer: { alignSelf: 'flex-start', fontSize: 13, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  skipped: { fontSize: 13, fontStyle: 'italic' },
  note: { fontSize: 13, borderLeftWidth: 2, paddingLeft: 8 },
  text: { flexShrink: 1, fontSize: 13.5, lineHeight: 19 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 6 },
  footerTime: { marginLeft: 'auto' },
})
