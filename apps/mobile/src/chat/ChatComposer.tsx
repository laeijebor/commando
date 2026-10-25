import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import {
  MAX_CHAT_IMAGES,
  hostTakesInput,
  hostTakesSettings,
  hostTakesTurnFlow,
  type ChatCarriedDraft,
  type ChatCommand,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatSendOptions,
  type ChatSessionInfo,
} from '@commando/agent-chat'
import {
  detectTrigger,
  filterCommands,
  fitAttachments,
  mentionText,
  modelMenuAvailable,
  moveCommandToStart,
  replaceRange,
  type ComposerTrigger,
} from '@commando/chat-composer'

import type { Host } from '../hosts/types'
import { providerPresentation } from '../ui/providerPresentation'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { CHAT_SEND_REFUSAL_MS, type ChatChannel, type ChatSendError } from './channel'
import { ContextMeter, IconButton, QueueList, SettingsPills, TriggerMenu, type MenuItem } from './ComposerParts'
import { pastedImage, useClipboardImage, type ClipboardImageData } from './clipboard'
import { spliceDictation, useDictation } from './dictation'
import { chatImageUri, pickImages, prepareImage, uploadChatImage, type PickedImage } from './images'
import { PasteImageBar } from './PasteImageBar'

type Attachment = { key: string; name: string; uri: string; ref?: ChatImageRef }

/** A pane's unsent draft, kept while the chat is off screen so it comes back on return. */
type Draft = { text: string; attachments: Attachment[] }
const drafts = new Map<string, Draft>()

/** Carried drafts this app already put in a composer, with how many of their images (the web's takenCarries). */
const takenCarries = new Map<string, number>()

const FILE_SEARCH_DEBOUNCE_MS = 80

let attachmentCounter = 0
function attachmentKey(prefix: string): string {
  attachmentCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${attachmentCounter}`
}

function restored(refs: readonly ChatImageRef[], baseUrl: string, prefix: string): Attachment[] {
  return refs.map((ref) => ({ key: attachmentKey(prefix), name: ref.name ?? 'image', uri: chatImageUri(baseUrl, ref.id), ref }))
}

/** `@` results for the trigger's query; stale answers are dropped. */
function useFileSearch(query: string | null, channel: ChatChannel | null) {
  const [state, setState] = useState<{ query: string; result: ChatFileSearchResult } | null>(null)
  useEffect(() => {
    if (query === null || !channel) return
    let current = true
    const timer = setTimeout(() => {
      void channel.searchFiles(query).then((result) => { if (current) setState({ query, result }) })
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, channel])
  // Keep the last answer while the next one loads, so the list doesn't flicker.
  return { result: state?.result ?? null, loading: query !== null && state?.query !== query }
}

function menuFor(
  trigger: ComposerTrigger,
  session: ChatSessionInfo,
  commands: readonly ChatCommand[] | undefined,
  files: { result: ChatFileSearchResult | null; loading: boolean },
): { label: string; items: MenuItem[]; status: string | null } {
  if (trigger.kind === 'slash') {
    const query = trigger.query.toLowerCase()
    const natives: MenuItem[] = [
      ...(modelMenuAvailable(session) ? [{ key: 'native:model', type: 'native' as const, name: 'model' as const, description: 'Choose the model' }] : []),
      // Muse has no plan mode.
      ...(hostTakesSettings(session) && session.permissionMode && session.provider !== 'muse'
        ? [{ key: 'native:plan', type: 'native' as const, name: 'plan' as const, description: session.permissionMode === 'plan' ? 'Leave plan mode' : 'Switch to plan mode' }]
        : []),
    ].filter((item) => item.type === 'native' && item.name.includes(query))
    const matched = filterCommands(commands ?? [], trigger.query)
    return {
      label: 'Commands and skills',
      items: [
        ...natives,
        // Skills run anywhere in a message; commands only at its start (a pick mid-message moves it there).
        ...matched.map((command) => ({ key: `${command.kind}:${command.name}`, type: 'command' as const, command, runsHere: command.kind === 'skill' || trigger.atStart })),
      ],
      status: commands ? (natives.length || matched.length ? null : 'No matching commands') : hostTakesInput(session) ? `${providerPresentation(session.provider).name}'s commands appear once the session has started` : `Restart this chat to list ${providerPresentation(session.provider).name}'s commands`,
    }
  }
  const entries = files.result?.entries ?? []
  return {
    label: 'Files and folders',
    items: entries.map((entry) => ({ key: `file:${entry.path}`, type: 'file' as const, entry })),
    status: files.result?.error ?? (files.loading && !entries.length ? 'Searching files…' : !entries.length && files.result ? 'No matching files or folders' : files.result?.truncated ? 'Showing the best matches; type more to narrow' : null),
  }
}

/**
 * The chat's composer on the phone, after the web's ChatComposer: send (or
 * queue while Claude works), Steer and Stop, the queue, images, the `/` and
 * `@` menus and the settings pills. Open requests sit above it.
 */
export function ChatComposer({ host, session, hostConnected, commands, carried, channel, sendError, onDismissSendError, actionError, onDismissActionError, onSend }: {
  onSend?: () => void
  host: Host
  session: ChatSessionInfo
  /** The phone is connected to the daemon, and the daemon to the chat's host. */
  hostConnected: boolean
  commands?: ChatCommand[] | undefined
  carried?: ChatCarriedDraft | undefined
  channel: ChatChannel
  sendError: ChatSendError | null
  onDismissSendError: () => void
  actionError: string | null
  onDismissActionError: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const draftKey = `${host.id}:${session.paneId}`
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(draftKey)?.attachments ?? [])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [selection, setSelection] = useState({ start: text.length, end: text.length })
  /** Set for one render after a pick rewrites the text, to move the caret. */
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>()
  const [dismissed, setDismissed] = useState<ComposerTrigger | null>(null)
  const [modelSheet, setModelSheet] = useState(0)
  const input = useRef<TextInput>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // Only uploaded images are kept: an upload in flight belongs to this screen.
  useEffect(() => {
    drafts.set(draftKey, { text, attachments: attachments.filter((attachment) => attachment.ref) })
  }, [draftKey, text, attachments])

  const running = session.status === 'running' || session.status === 'waiting'
  const closed = session.status === 'closed' || session.status === 'error'
  // A switch to Claude Code takes the draft as it is; answers and Stop still work.
  const switching = Boolean(session.claudeCodeSwitch)
  const disabled = !hostConnected || closed || switching
  const richInput = hostTakesInput(session)
  const turnFlow = hostTakesTurnFlow(session)
  const queue = turnFlow ? session.queue ?? [] : []
  const uploading = attachments.some((attachment) => !attachment.ref)
  const canSend = !disabled && !uploading && Boolean(text.trim() || attachments.length)

  const candidate = selection.start === selection.end ? detectTrigger(text, selection.start) : null
  const blocked = candidate && dismissed && candidate.kind === dismissed.kind && candidate.rangeStart === dismissed.rangeStart
  useEffect(() => {
    // A dismissed menu stays closed until the caret leaves its token.
    if (dismissed && !blocked) setDismissed(null)
  }, [dismissed, blocked])
  const trigger = !disabled && candidate && !blocked && (candidate.kind === 'slash' || (candidate.kind === 'mention' && richInput)) ? candidate : null
  const files = useFileSearch(trigger?.kind === 'mention' ? trigger.query : null, channel)
  const menu = useMemo(() => (trigger ? menuFor(trigger, session, commands, files) : null), [trigger, session, commands, files])

  // The draft as of the latest change, ahead of the render it causes (a dictation can start in between).
  const draftNow = useRef({ text, selection })
  draftNow.current = { text, selection }

  const applyText = (next: { text: string; cursor: number }) => {
    draftNow.current = { text: next.text, selection: { start: next.cursor, end: next.cursor } }
    setText(next.text)
    setSelection({ start: next.cursor, end: next.cursor })
    setForcedSelection({ start: next.cursor, end: next.cursor })
  }

  const pick = (item: MenuItem) => {
    if (!trigger) return
    void Haptics.selectionAsync()
    switch (item.type) {
      case 'native':
        applyText(replaceRange(text, trigger.rangeStart, trigger.rangeEnd, ''))
        if (item.name === 'model') setModelSheet((count) => count + 1)
        else channel.configure({ permissionMode: session.permissionMode === 'plan' ? 'default' : 'plan' })
        return
      case 'command':
        applyText(item.runsHere
          ? replaceRange(text, trigger.rangeStart, trigger.rangeEnd, `/${item.command.name} `)
          : moveCommandToStart(text, trigger, item.command.name))
        return
      case 'file':
        applyText(replaceRange(text, trigger.rangeStart, trigger.rangeEnd, mentionText(item.entry)))
    }
  }

  /** Room for more images, or why there is none (the error is shown). */
  const roomForImages = (): number => {
    setAttachError(null)
    if (!richInput) {
      setAttachError('Restart this chat to attach images')
      return 0
    }
    const room = MAX_CHAT_IMAGES - attachments.length
    if (room <= 0) setAttachError(`A message can carry at most ${MAX_CHAT_IMAGES} images`)
    return Math.max(0, room)
  }

  /** Picked or pasted images join the draft at once, then shrink and upload behind a spinner. */
  const addImages = (images: readonly PickedImage[]) => {
    for (const image of images) {
      const key = attachmentKey('picked')
      setAttachments((current) => [...current, { key, name: image.name, uri: image.uri }])
      const drop = (error: string) => {
        if (!mounted.current) return
        setAttachments((current) => current.filter((attachment) => attachment.key !== key))
        setAttachError(error)
      }
      void (async () => {
        try {
          const prepared = await prepareImage(image)
          if (!prepared.ok) return drop(prepared.error)
          const ref = await uploadChatImage(host, prepared.image)
          if (!mounted.current) return
          setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, name: prepared.image.name, uri: prepared.image.uri, ref } : attachment)))
        } catch (error) {
          drop(`${image.name} didn't upload: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }
  }

  const attach = async () => {
    const room = roomForImages()
    if (!room) return
    let picked
    try {
      picked = await pickImages(room)
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!picked?.length || !mounted.current) return
    addImages(picked)
  }

  // The clipboard's image is offered while it holds one; a paste uses it up until the clipboard changes.
  const clipboardImage = useClipboardImage(richInput && !disabled)
  const pasteImage = (data: ClipboardImageData) => {
    // Kept on offer when there's no room, so it can come in once an image is removed.
    if (!roomForImages()) return
    clipboardImage.dismiss()
    const image = pastedImage(data)
    if (!image) {
      setAttachError('The clipboard image is in a format that can\'t be attached')
      return
    }
    void Haptics.selectionAsync()
    addImages([image])
  }

  // Dictation replaces the selection it started on; each new transcript redoes that from the same draft.
  const [dictationHint, setDictationHint] = useState<string | null>(null)
  const dictationBase = useRef({ text: '', selection: { start: 0, end: 0 } })
  const dictation = useDictation({
    onBegin: () => {
      dictationBase.current = draftNow.current
      setDictationHint(null)
      setAttachError(null)
    },
    onTranscript: (spoken) => applyText(spliceDictation(dictationBase.current.text, dictationBase.current.selection, spoken)),
    onError: setAttachError,
    onHint: setDictationHint,
  })
  useEffect(() => {
    if (!dictationHint) return
    const timer = setTimeout(() => setDictationHint(null), 2500)
    return () => clearTimeout(timer)
  }, [dictationHint])
  const canDictate = dictation.available && !closed && !switching
  // The mic leaves mid-hold when the session ends or switches; its release would never come.
  useEffect(() => {
    if (!canDictate) dictation.cancel()
  }, [canDictate, dictation.cancel])

  const clearDraft = () => {
    setAttachments([])
    setAttachError(null)
    setText('')
    setSelection({ start: 0, end: 0 })
  }

  // Each send's draft is kept by its request id, so a refusal puts back what it refused.
  const sentDrafts = useRef(new Map<string, { text: string; images: ChatImageRef[]; at: number }>())
  useEffect(() => {
    let count = attachments.length
    for (const { requestId, code } of sendError?.refused ?? []) {
      const sent = sentDrafts.current.get(requestId)
      if (!sent || Date.now() - sent.at > CHAT_SEND_REFUSAL_MS) continue
      sentDrafts.current.delete(requestId)
      if (sent.text) setText((current) => (current.trim() ? `${current}\n\n${sent.text}` : sent.text))
      // A missing image has to be attached again, as the error says.
      if (!sent.images.length || code === 'chat_image_missing') continue
      const fit = fitAttachments(count, sent.images.length)
      if (fit.error) setAttachError(fit.error)
      count += fit.accepted
      setAttachments((current) => [...current, ...restored(sent.images.slice(0, fit.accepted), host.baseUrl, 'refused')])
    }
    // Only a new refusal restores; the attachments it reads are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendError])

  // Back from Claude Code: what the chat held comes back into the composer, once.
  const reportedCarries = useRef(new Set<string>())
  useEffect(() => {
    if (!carried || switching || reportedCarries.current.has(carried.id)) return
    let taken = takenCarries.get(carried.id)
    if (taken === undefined) {
      const fit = fitAttachments(attachments.length, carried.images.length)
      const waiting = carried.images.length - fit.accepted
      if (waiting) setAttachError(`${waiting} image${waiting === 1 ? '' : 's'} from before Claude Code ${waiting === 1 ? "doesn't" : "don't"} fit in this message yet; ${waiting === 1 ? 'it comes' : 'they come'} back once you send or remove attachments`)
      if (!carried.text && fit.accepted === 0) return
      taken = fit.accepted
      takenCarries.set(carried.id, taken)
      if (carried.text) setText((current) => [carried.text, current.trim()].filter(Boolean).join('\n\n'))
      const images = restored(carried.images.slice(0, taken), host.baseUrl, 'carried')
      if (images.length) setAttachments((current) => [...images, ...current])
    }
    // Unreported, the daemon would offer the same draft to another composer; try again on the next render.
    if (channel.carryTaken(carried.id, taken)) reportedCarries.current.add(carried.id)
    // A carried draft is taken once; room for its images is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried?.id, attachments.length, switching])

  /** Enter (the send button) queues while Claude works; Steer sends now. */
  const submit = (steer = false) => {
    if (!canSend) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    const images = attachments.flatMap((attachment) => (attachment.ref ? [attachment.ref] : []))
    const options: ChatSendOptions = running && turnFlow ? { delivery: steer ? 'steer' : 'queue' } : {}
    const sent = text.trim()
    const requestId = channel.send(sent, images, options)
    onSend?.()
    const now = Date.now()
    for (const [id, draft] of sentDrafts.current) if (now - draft.at > CHAT_SEND_REFUSAL_MS) sentDrafts.current.delete(id)
    sentDrafts.current.set(requestId, { text: sent, images, at: now })
    clearDraft()
  }

  /** Stop. As in the Claude Code TUI, queued messages come back into the composer to edit. */
  const stop = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    if (!queue.length) {
      channel.interrupt()
      return
    }
    // Only what fits beside the attachments already here comes back; the rest stays queued.
    let room = MAX_CHAT_IMAGES - attachments.length
    const taken = queue.filter((queued) => {
      const count = queued.images?.length ?? 0
      if (count > room) return false
      room -= count
      return true
    })
    setText((current) => [...taken.map((queued) => queued.text), current.trim()].filter(Boolean).join('\n\n'))
    const images = restored(taken.flatMap((queued) => queued.images ?? []), host.baseUrl, 'queued')
    if (images.length) setAttachments((current) => [...images, ...current])
    const left = queue.length - taken.length
    if (left) setAttachError(`${left} queued message${left === 1 ? ' has' : 's have'} too many images to bring back here, so ${left === 1 ? 'it stays' : 'they stay'} queued`)
    channel.interrupt(taken.map((queued) => queued.id))
  }

  const shownError = attachError ?? sendError?.message ?? actionError
  const dismissError = () => {
    if (attachError) setAttachError(null)
    else if (sendError) onDismissSendError()
    else onDismissActionError()
  }
  const placeholder = !hostConnected
    ? 'Reconnecting to the agent host…'
    : switching
      ? 'Switching to Claude Code…'
      : closed
        ? 'This session has ended'
        : running ? 'Queue a message…' : `Ask ${providerPresentation(session.provider).name}… / for commands, @ for files`

  return (
    <View style={styles.wrap}>
      <View style={[styles.box, { backgroundColor: theme.surface, borderColor: theme.borderMid }]} testID="chat-composer">
        {queue.length ? (
          <QueueList provider={session.provider}
            disabled={!hostConnected}
            onChange={(change) => channel.queue(change)}
            onEditOrphaned={(edit) => {
              setText((current) => [current.trim(), edit].filter(Boolean).join('\n\n'))
              setAttachError('That message was sent before your edit was saved; your edit is in the composer')
            }}
            queue={queue}
          />
        ) : null}
        {menu && trigger ? (
          <TriggerMenu items={menu.items} label={menu.label} onDismiss={() => setDismissed(trigger)} onPick={pick} status={menu.status} />
        ) : null}
        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachments} keyboardShouldPersistTaps="always">
            {attachments.map((attachment) => (
              <View key={attachment.key} style={styles.thumb}>
                <Image accessibilityLabel={attachment.name} source={{ uri: attachment.uri }} style={[styles.thumbImage, { borderColor: theme.border }]} />
                {attachment.ref ? null : (
                  <View style={[styles.thumbBusy, { backgroundColor: withAlpha(theme.bg, 0.55) }]}>
                    <ActivityIndicator color={theme.text} size="small" />
                  </View>
                )}
                <Pressable
                  accessibilityLabel={`Remove ${attachment.name}`}
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => {
                    setAttachError(null)
                    setAttachments((current) => current.filter((entry) => entry.key !== attachment.key))
                  }}
                  style={[styles.thumbRemove, { backgroundColor: theme.surfaceSoft, borderColor: theme.borderMid }]}
                >
                  <Feather color={theme.text} name="x" size={11} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {shownError ? (
          <View style={styles.error}>
            <Text accessibilityLiveRegion="polite" style={[styles.errorText, { color: theme.red }]}>{shownError}</Text>
            <IconButton icon="x" label="Dismiss" onPress={dismissError} />
          </View>
        ) : null}
        {dictationHint ? (
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.muted }]}>{dictationHint}</Text>
        ) : null}
        {clipboardImage.available ? (
          <PasteImageBar onDismiss={clipboardImage.dismiss} onError={setAttachError} onImage={pasteImage} />
        ) : null}
        <TextInput
          accessibilityLabel={`Message ${providerPresentation(session.provider).name}`}
          autoCapitalize="sentences"
          // A dropped connection only stops sending: making the field read-only
          // would resign it, so a reconnect would close the keyboard mid-sentence.
          editable={!closed && !switching}
          multiline
          onChangeText={setText}
          onFocus={clipboardImage.recheck}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection)
            if (forcedSelection) setForcedSelection(undefined)
          }}
          placeholder={dictation.listening ? 'Listening…' : placeholder}
          placeholderTextColor={theme.textDim}
          ref={input}
          scrollEnabled
          selection={forcedSelection}
          style={[styles.field, { color: theme.text }]}
          testID="chat-input"
          value={text}
        />
        <View style={styles.bar}>
          {richInput ? <IconButton disabled={disabled} icon="paperclip" label="Attach images" onPress={() => void attach()} /> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills} style={styles.pillsScroll} keyboardShouldPersistTaps="always">
            {/* A resumed chat replays its history before Claude starts, and can't switch until then. */}
            <SettingsPills
              disabled={disabled || session.status === 'starting'}
              modelSheet={modelSheet}
              onConfigure={(change) => channel.configure(change)}
              onModelSheetShown={() => input.current?.blur()}
              session={session}
            />
            {session.contextUsage ? <ContextMeter usage={session.contextUsage} /> : null}
          </ScrollView>
          {running ? (
            <Pressable
              accessibilityLabel="Stop"
              accessibilityRole="button"
              accessibilityHint={queue.length ? 'Queued messages come back into the composer' : undefined}
              disabled={!hostConnected}
              onPress={stop}
              style={[styles.round, styles.stop, { borderColor: theme.borderMid, opacity: hostConnected ? 1 : 0.4 }]}
            >
              <View style={[styles.stopGlyph, { backgroundColor: theme.red }]} />
            </Pressable>
          ) : null}
          {running && turnFlow ? (
            <Pressable
              accessibilityLabel="Steer now"
              accessibilityHint={`Ends ${providerPresentation(session.provider).name}'s turn at its next safe point and sends this`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={() => submit(true)}
              style={[styles.round, styles.stop, { borderColor: theme.borderMid, opacity: canSend ? 1 : 0.4 }]}
            >
              <Feather color={theme.accent} name="zap" size={15} />
            </Pressable>
          ) : null}
          {canDictate ? (
            <Pressable
              accessibilityHint="Hold to talk; release to stop"
              accessibilityLabel={dictation.listening ? 'Listening' : 'Dictate'}
              accessibilityRole="button"
              accessibilityState={{ busy: dictation.listening }}
              onPressIn={dictation.begin}
              onPressOut={dictation.end}
              style={[styles.round, styles.stop, dictation.listening
                ? { backgroundColor: withAlpha(theme.red, 0.18), borderColor: theme.red }
                : { borderColor: theme.borderMid }]}
              testID="chat-dictate"
            >
              <Feather color={dictation.listening ? theme.red : theme.muted} name="mic" size={16} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={running && turnFlow ? 'Queue' : 'Send'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => submit()}
            style={[styles.round, { backgroundColor: theme.accent, opacity: canSend ? 1 : 0.4 }]}
          >
            <Feather color={theme.accentInk} name="arrow-up" size={18} />
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { width: '100%', maxWidth: 776, alignSelf: 'center', flexShrink: 0, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 },
  box: { borderWidth: 1, borderRadius: 20, overflow: 'hidden' },
  attachments: { gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  thumb: { width: 56, height: 56 },
  thumbImage: { width: 56, height: 56, borderRadius: 10, borderWidth: 1 },
  thumbBusy: { ...StyleSheet.absoluteFill, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  thumbRemove: { position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  error: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 14, paddingRight: 4, paddingTop: 8 },
  errorText: { flex: 1, fontSize: 12.5, lineHeight: 17, paddingTop: 6 },
  hint: { fontSize: 12.5, lineHeight: 17, paddingHorizontal: 14, paddingTop: 8 },
  field: { fontSize: 15, lineHeight: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4, minHeight: 40, maxHeight: 140 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 8, paddingBottom: 8 },
  pillsScroll: { flex: 1 },
  pills: { alignItems: 'center', gap: 6, paddingRight: 4 },
  round: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stop: { borderWidth: 1 },
  stopGlyph: { width: 11, height: 11, borderRadius: 2 },
})
