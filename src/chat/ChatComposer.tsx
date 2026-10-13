import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Archive, ArrowUp, CheckSquare, Circle, CircleDot, Paperclip, Square, SquareCheckBig, X, Zap } from 'lucide-react'
import {
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGES,
  chatImageUrl,
  chatPlanTitle,
  hostTakesInput,
  hostTakesSettings,
  hostTakesTurnFlow,
  type ChatAnswer,
  type ChatCarriedDraft,
  type ChatCommand,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatItem,
  type ChatQueueAction,
  type ChatSendOptions,
  type ChatSessionInfo,
  type ChatSessionPermissionMode,
  type ChatSettingsChange,
} from '../../shared/agent-chat'
import { prepareImage, type PreparedImage } from './attachImages'
import { ImageViewer, Thumbnail, type ViewableImage } from './ChatImages'
import { cn } from './cn'
import { handleLineKey } from './composerKeys'
import { ComposerMenu, type ComposerMenuGroup, type ComposerMenuItem } from './ComposerMenu'
import { ContextMeter, ModelPicker, PermissionPicker, PlanUsageMeter } from './ComposerControls'
import { usePlanUsage } from './planUsage'
import { ImplementButton, PlanReadyBanner, QueuedMessages, RelayChip } from './ComposerFlow'
import {
  detectTrigger,
  filterCommands,
  fitAttachments,
  mentionText,
  modelMenuAvailable,
  moveCommandToStart,
  providerLabel,
  replaceRange,
  type ComposerTrigger,
} from '../../shared/chat-composer'
import { filterPullRequests, pullRequestText, useTriggerState, type PullRequestOption } from './composerTriggers'
import { StashMenu } from './StashMenu'
import { useNow } from './Subagents'
import { shortPath, type PlanItem } from '../../shared/chat-timeline'
import { Button } from './ui/button'
import { useComposerStash, type StashedDraft } from './useComposerStash'
import { loadDraft, saveDraft } from './draftStore'

/** What the composer asks of the app for `@`, `#` and images. */
export interface ChatInputServices {
  searchFiles: (query: string) => Promise<ChatFileSearchResult>
  /** Open pull requests in the chat's repository. */
  pullRequests: () => Promise<PullRequestOption[]>
  uploadImage: (image: PreparedImage) => Promise<ChatImageRef>
}

/** Sends the daemon refused, named by the request ids `onSend` returned. */
export interface ChatSendError {
  /** The latest refusal's reason. */
  message: string
  /** Every refusal since the error was last cleared, so two that land together each restore. */
  refused: { requestId: string; code?: string }[]
}

/** How long the app matches a refusal to its send; the composer keeps a sent draft as long. */
export const CHAT_SEND_REFUSAL_MS = 30_000

type RequestItem = Extract<ChatItem, { kind: 'request' }>
type TodoItem = Extract<ChatItem, { kind: 'todo_list' }>

// Approval panel, after t3code's ComposerPendingApprovalPanel/Actions.
function ApprovalPanel({ request, pendingCount, cwd, disabled, onAnswer }: { request: RequestItem; pendingCount: number; cwd: string; disabled: boolean; onAnswer: (answer: ChatAnswer) => void }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-warning-surface px-3 py-2.5" role="group" aria-label={request.title}>
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-semibold uppercase tracking-wide text-warning">{request.title}</span>
        {pendingCount > 1 ? <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span> : null}
      </div>
      {request.detail ? (
        <code className="block max-h-24 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground">
          {shortPath(request.detail, cwd)}
        </code>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" disabled={disabled} onClick={() => onAnswer({ kind: 'approval', decision: 'allow' })}>Allow once</Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => onAnswer({ kind: 'approval', decision: 'allow_always' })}>Always allow</Button>
        <Button size="xs" variant="destructive-outline" disabled={disabled} onClick={() => onAnswer({ kind: 'approval', decision: 'deny' })}>Deny</Button>
      </div>
    </div>
  )
}

// AskUserQuestion, after t3code's ComposerPendingUserInputPanel.
function QuestionPanel({ request, provider, disabled, onAnswer }: { request: RequestItem; provider: string; disabled: boolean; onAnswer: (answer: ChatAnswer) => void }) {
  const questions = request.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const toggle = (question: string, label: string, multi: boolean) => {
    setSelected((current) => {
      const chosen = current[question] ?? []
      const next = multi ? (chosen.includes(label) ? chosen.filter((value) => value !== label) : [...chosen, label]) : [label]
      return { ...current, [question]: next }
    })
  }
  const answerFor = (question: string) => {
    const typed = other[question]?.trim()
    return typed || (selected[question] ?? []).join(', ')
  }
  const complete = questions.every((question) => answerFor(question.question))
  return (
    <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto border-b border-border bg-warning-surface px-3 py-2.5" role="group" aria-label={`${provider} is asking`}>
      <span className="text-2xs font-semibold uppercase tracking-wide text-warning">{provider} is asking</span>
      {questions.map((question) => {
        const chosen = selected[question.question] ?? []
        return (
          <fieldset key={question.question} className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-sm text-foreground">
              {question.header ? <span className="mr-1.5 rounded-sm bg-secondary px-1 py-0.5 text-2xs text-muted-foreground">{question.header}</span> : null}
              {question.question}
            </legend>
            {question.options.map((option) => {
              const active = chosen.includes(option.label)
              const Icon = question.multiSelect ? (active ? SquareCheckBig : Square) : active ? CircleDot : Circle
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(question.question, option.label, question.multiSelect)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-left text-sm',
                    active ? 'border-primary text-foreground' : 'border-border text-secondary-label hover:bg-accent',
                  )}
                >
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', active ? 'text-primary' : 'text-icon-muted')} aria-hidden="true" />
                  <span className="min-w-0">
                    {option.label}
                    {option.description ? <span className="block text-xs text-muted-foreground">{option.description}</span> : null}
                  </span>
                </button>
              )
            })}
            <input
              className="h-7 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground"
              placeholder="Or type an answer"
              value={other[question.question] ?? ''}
              onChange={(event) => setOther((current) => ({ ...current, [question.question]: event.target.value }))}
            />
          </fieldset>
        )
      })}
      <div className="flex gap-1.5">
        <Button size="xs" disabled={disabled || !complete} onClick={() => onAnswer({ kind: 'question', answers: Object.fromEntries(questions.map((question) => [question.question, answerFor(question.question)])) })}>
          Answer
        </Button>
      </div>
    </div>
  )
}

function TodoChip({ todos }: { todos: TodoItem }) {
  const [open, setOpen] = useState(false)
  const done = todos.todos.filter((todo) => todo.status === 'completed').length
  return (
    <span className="relative">
      <Button size="xs" variant="ghost-muted" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <CheckSquare aria-hidden="true" />
        {done}/{todos.todos.length} tasks
      </Button>
      {open ? (
        <ul className="absolute bottom-8 left-0 z-10 flex w-72 flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-sm shadow-lg">
          {todos.todos.map((todo, index) => (
            <li key={index} className={cn('flex items-start gap-1.5', todo.status === 'completed' ? 'text-muted-foreground line-through' : todo.status === 'in_progress' ? 'text-foreground' : 'text-secondary-label')}>
              {todo.status === 'completed' ? <SquareCheckBig className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" /> : <Square className={cn('mt-0.5 size-3.5 shrink-0', todo.status === 'in_progress' ? 'text-primary' : 'text-icon-muted')} aria-hidden="true" />}
              <span className="min-w-0">{todo.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  )
}

type Attachment = { key: string; name: string; previewUrl: string; ref?: ChatImageRef }

const uploadedRefs = (attachments: Attachment[]) => attachments.flatMap((attachment) => (attachment.ref ? [attachment.ref] : []))

/** A saved draft's images, previewed from the daemon's copies. */
const savedAttachments = (refs: ChatImageRef[]): Attachment[] => refs.map((ref, index) => ({
  key: `saved-${index}-${ref.id}`,
  name: ref.name ?? 'image',
  previewUrl: chatImageUrl(ref.id),
  ref,
}))

/** The draft a switch to Claude Code carries across: text and uploaded images. */
export type ChatDraft = { text: string; images: ChatImageRef[] }

/**
 * Carried drafts this page already put in a composer, with how many of their
 * images, so a remount before the daemon clears one doesn't add it twice.
 */
const takenCarries = new Map<string, number>()

const FILE_SEARCH_DEBOUNCE_MS = 80
const PR_CACHE_MS = 60_000
/** A failed load is retried sooner (e.g. once the branch is pushed). */
const PR_ERROR_CACHE_MS = 5_000

/** `@` results for the trigger's query; stale answers are dropped. */
function useFileSearch(trigger: ComposerTrigger | null, services: ChatInputServices | undefined, enabled: boolean) {
  const query = trigger?.kind === 'mention' && enabled ? trigger.query : null
  const [state, setState] = useState<{ query: string; result: ChatFileSearchResult } | null>(null)
  useEffect(() => {
    if (query === null || !services) return
    let current = true
    const timer = setTimeout(() => {
      services.searchFiles(query).then(
        (result) => { if (current) setState({ query, result }) },
        (error: unknown) => { if (current) setState({ query, result: { entries: [], truncated: false, error: error instanceof Error ? error.message : 'File search failed' } }) },
      )
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, services])
  // Keep showing the last answer while the next one loads, so the list doesn't flicker.
  return { result: state?.result ?? null, loading: query !== null && state?.query !== query }
}

/** Open pull requests, loaded when `#` opens and reused for a minute. */
function usePullRequests(open: boolean, services: ChatInputServices | undefined) {
  const [state, setState] = useState<{ at: number; prs: PullRequestOption[]; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open || !services || loading || (state && Date.now() - state.at < (state.error ? PR_ERROR_CACHE_MS : PR_CACHE_MS))) return
    setLoading(true)
    services.pullRequests().then(
      (prs) => setState({ at: Date.now(), prs }),
      (error: unknown) => setState({ at: Date.now(), prs: [], error: error instanceof Error ? error.message : 'Pull requests failed to load' }),
    ).finally(() => setLoading(false))
  }, [open, services, loading, state])
  return { prs: state?.prs ?? [], error: state?.error, loading: loading && !state }
}

const MENU_LABELS: Record<ComposerTrigger['kind'], string> = { slash: 'Commands and skills', mention: 'Files and folders', pr: 'Pull requests' }

function menuGroups(
  trigger: ComposerTrigger,
  session: ChatSessionInfo,
  commands: readonly ChatCommand[] | undefined,
  files: { result: ChatFileSearchResult | null; loading: boolean },
  prs: { prs: PullRequestOption[]; error?: string; loading: boolean },
): { groups: ComposerMenuGroup[]; status: string | null } {
  if (trigger.kind === 'slash') {
    const query = trigger.query.toLowerCase()
    const natives = [
      ...(modelMenuAvailable(session) ? [{ name: 'model', description: 'Choose the model and effort' }] : []),
      ...(hostTakesSettings(session) && session.permissionMode
        ? [{ name: 'plan', description: session.permissionMode === 'plan' ? 'Leave plan mode' : 'Switch to plan mode' }]
        : []),
    ].filter((native) => native.name.includes(query))
    const matched = filterCommands(commands ?? [], trigger.query)
    const skills = matched.filter((command) => command.kind === 'skill')
    const rest = matched.filter((command) => command.kind === 'command')
    const skillGroup: ComposerMenuGroup = {
      label: 'Skills',
      ...(trigger.atStart ? {} : { note: `${providerLabel(session)} can run these mid-message` }),
      items: skills.map((command) => ({ key: `skill:${command.name}`, type: 'command' as const, command, runsHere: true })),
    }
    const commandGroup: ComposerMenuGroup = {
      label: 'Commands',
      ...(trigger.atStart ? {} : { note: 'only run at the start of a message' }),
      items: [
        ...natives.map((native) => ({ key: `native:${native.name}`, type: 'native' as const, ...native })),
        ...rest.map((command) => ({ key: `command:${command.name}`, type: 'command' as const, command, runsHere: trigger.atStart })),
      ],
    }
    // Whichever group holds the best match comes first (`/re` → recap and rename before skills).
    const commandsFirst = Boolean(query) && (natives.some((native) => native.name.startsWith(query)) || matched[0]?.kind === 'command')
    return {
      groups: commandsFirst ? [commandGroup, skillGroup] : [skillGroup, commandGroup],
      status: commands ? null : hostTakesInput(session) ? `${providerLabel(session)}'s commands appear once the session has started` : `Restart this chat to list ${providerLabel(session)}'s commands`,
    }
  }
  if (trigger.kind === 'mention') {
    const entries = files.result?.entries ?? []
    return {
      groups: [{ label: 'Files and folders', items: entries.map((entry) => ({ key: `file:${entry.path}`, type: 'file' as const, entry })) }],
      status: files.result?.error ?? (files.loading && !entries.length ? 'Searching files…' : !entries.length && files.result ? 'No matching files or folders' : files.result?.truncated ? 'Showing the best matches; type more to narrow' : null),
    }
  }
  const matching = filterPullRequests(prs.prs, trigger.query)
  return {
    groups: [{ label: 'Pull requests', items: matching.map((pr) => ({ key: `pr:${pr.number}`, type: 'pr' as const, pr })) }],
    status: prs.error ?? (prs.loading ? 'Loading open pull requests…' : matching.length ? null : 'No open pull requests match'),
  }
}

function profileLabel(configDir: string | undefined): string | null {
  if (!configDir) return null
  const name = configDir.split('/').filter(Boolean).pop() ?? ''
  return name.replace(/^\./, '') || null
}

export function ChatComposer({
  session,
  hostConnected,
  requests,
  todos,
  commands,
  services,
  sendError,
  onDismissSendError,
  actionError,
  onDismissActionError,
  onSend,
  onInterrupt,
  onAnswer,
  onConfigure,
  autoFocus,
  plan,
  onImplement,
  onImplementInNewPane,
  onQueue,
  relayTarget,
  onClearRelay,
  carried,
  onCarriedTaken,
  registerDraft,
  onUploadingChange,
}: {
  session: ChatSessionInfo
  hostConnected: boolean
  requests: RequestItem[]
  todos?: TodoItem
  /** Claude Code's commands and skills, for the `/` menu. */
  commands?: ChatCommand[]
  services?: ChatInputServices
  sendError?: ChatSendError
  onDismissSendError?: () => void
  /** A queue, subagent or plan action that failed; unlike a refused send, nothing goes back into the draft. */
  actionError?: string
  onDismissActionError?: () => void
  /** Returns the send's request id, which a refusal names. */
  onSend: (text: string, images?: ChatImageRef[], options?: ChatSendOptions) => string | void
  /** `dropQueued`: queued messages Stop took back into the draft. */
  onInterrupt: (dropQueued?: string[]) => void
  onAnswer: (requestId: string, answer: ChatAnswer) => void
  onConfigure: (change: ChatSettingsChange) => void
  autoFocus?: boolean
  /** Claude's latest plan, while it waits to be implemented or refined. */
  plan?: { item: PlanItem; implementMode: ChatSessionPermissionMode }
  onImplement?: () => void
  onImplementInNewPane?: () => void
  onQueue?: (change: ChatQueueAction) => void
  /** Messages go to this subagent, relayed through main Claude. */
  relayTarget?: { agentId: string; label: string }
  onClearRelay?: () => void
  /** The draft and queue the chat had when it switched to Claude Code, back in the composer. */
  carried?: ChatCarriedDraft
  /** `images`: how many of the carried images came back; the rest wait for room. */
  onCarriedTaken?: (carryId: string, images: number) => void
  /** Lets a switch to Claude Code read the unsent draft. */
  registerDraft?: (read: (() => ChatDraft) | null) => void
  /** An image is still uploading: a switch now would leave it behind. */
  onUploadingChange?: (uploading: boolean) => void
}) {
  const [initial] = useState(() => loadDraft(session.sessionId))
  const [draft, setDraft] = useState(initial.text)
  const [attachments, setAttachments] = useState<Attachment[]>(() => savedAttachments(initial.images))
  const [draftSessionId, setDraftSessionId] = useState(session.sessionId)
  const restoredDraft = useRef(draft)
  // The session id can arrive after mount; restore before an effect saves an empty draft.
  if (session.sessionId !== draftSessionId) {
    setDraftSessionId(session.sessionId)
    const late = draft && attachments.length ? null : loadDraft(session.sessionId)
    if (late && !draft) {
      restoredDraft.current = late.text
      setDraft(late.text)
    }
    if (late && !attachments.length) setAttachments(savedAttachments(late.images))
  }
  const images = useMemo(() => uploadedRefs(attachments), [attachments])
  const storedDraft = useMemo(() => ({ text: draft, images }), [session.sessionId])
  useLayoutEffect(() => {
    storedDraft.text = draft
    storedDraft.images = images
  }, [storedDraft, draft, images])
  useEffect(() => {
    const flush = () => saveDraft(session.sessionId, storedDraft.text, storedDraft.images)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [session.sessionId, storedDraft])
  useEffect(() => {
    if (!draft && !images.length) {
      saveDraft(session.sessionId, '')
      return
    }
    const timeout = window.setTimeout(() => saveDraft(session.sessionId, draft, images), 300)
    return () => window.clearTimeout(timeout)
  }, [session.sessionId, draft, images])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const menuId = useId()
  const provider = providerLabel(session)
  const running = session.status === 'running' || session.status === 'waiting'
  const closed = session.status === 'closed' || session.status === 'error'
  // A switch to Claude Code takes the draft as it is; answers and Stop still work.
  const switching = Boolean(session.claudeCodeSwitch)
  const disabled = !hostConnected || closed || switching
  const request = requests[0]
  // Hosts started before 1b·2 can't search files or take images.
  const richInput = Boolean(services) && hostTakesInput(session)
  // Hosts started before 1b·3 can't hold a queue or steer.
  const turnFlow = hostTakesTurnFlow(session)
  const queue = turnFlow ? session.queue ?? [] : []
  const { trigger, update: updateTrigger, dismiss } = useTriggerState()
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewing, setViewing] = useState<ViewableImage | null>(null)
  const files = useFileSearch(trigger, services, richInput)
  const prs = usePullRequests(trigger?.kind === 'pr', services)

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [draft])

  useEffect(() => {
    if (autoFocus) textarea.current?.focus()
  }, [autoFocus])

  // Object URLs for previews are released when attachments go or the composer unmounts.
  const previews = useRef(new Set<string>())
  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url) }, [])
  const release = (attachment: Attachment) => {
    URL.revokeObjectURL(attachment.previewUrl)
    previews.current.delete(attachment.previewUrl)
  }

  const syncTrigger = useCallback((element: HTMLTextAreaElement) => {
    updateTrigger(element.selectionStart === element.selectionEnd ? detectTrigger(element.value, element.selectionStart) : null)
  }, [updateTrigger])

  // After a pick rewrites the draft, put the caret after the inserted text.
  useLayoutEffect(() => {
    const element = textarea.current
    const caret = pendingCaret.current
    if (!element || caret === null) return
    pendingCaret.current = null
    element.focus()
    element.setSelectionRange(caret, caret)
    syncTrigger(element)
  }, [draft, syncTrigger])

  // `@` needs a host that can search; `#` needs the app's PR access.
  const menuOpen = trigger !== null && !disabled
    && (trigger.kind === 'slash' || (trigger.kind === 'mention' && richInput) || (trigger.kind === 'pr' && Boolean(services)))
  const { groups, status } = useMemo(
    () => (menuOpen && trigger ? menuGroups(trigger, session, commands, files, prs) : { groups: [], status: null }),
    [menuOpen, trigger, session, commands, files, prs],
  )
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const active = items.find((item) => item.key === activeKey) ?? items[0]

  useEffect(() => { setActiveKey(null) }, [trigger?.kind, trigger?.rangeStart, trigger?.query])

  const applyText = (next: { text: string; cursor: number }) => {
    pendingCaret.current = next.cursor
    setDraft(next.text)
  }

  const pick = (item: ComposerMenuItem) => {
    if (!trigger) return
    switch (item.type) {
      case 'native':
        applyText(replaceRange(draft, trigger.rangeStart, trigger.rangeEnd, ''))
        if (item.name === 'model') setModelMenuOpen(true)
        else onConfigure({ permissionMode: session.permissionMode === 'plan' ? 'default' : 'plan' })
        return
      case 'command':
        applyText(item.runsHere
          ? replaceRange(draft, trigger.rangeStart, trigger.rangeEnd, `/${item.command.name} `)
          : moveCommandToStart(draft, trigger, item.command.name))
        return
      case 'file':
        applyText(replaceRange(draft, trigger.rangeStart, trigger.rangeEnd, mentionText(item.entry)))
        return
      case 'pr':
        applyText(replaceRange(draft, trigger.rangeStart, trigger.rangeEnd, pullRequestText(item.pr)))
    }
  }

  const addImages = (incoming: File[]) => {
    if (!incoming.length) return
    if (!richInput || !services) {
      setAttachError('Restart this chat to attach images')
      return
    }
    const fit = fitAttachments(attachments.length, incoming.length)
    setAttachError(fit.error ?? null)
    for (const file of incoming.slice(0, fit.accepted)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const previewUrl = URL.createObjectURL(file)
      previews.current.add(previewUrl)
      const name = file.name || 'pasted image'
      setAttachments((current) => [...current, { key, name, previewUrl }])
      const drop = (error: string) => {
        setAttachments((current) => current.filter((attachment) => {
          if (attachment.key === key) release(attachment)
          return attachment.key !== key
        }))
        setAttachError(error)
      }
      void (async () => {
        const prepared = await prepareImage(file)
        if (!prepared.ok) return drop(prepared.error)
        try {
          const ref = await services.uploadImage(prepared.image)
          setAttachments((current) => current.map((attachment) => (attachment.key === key ? { ...attachment, name: prepared.image.name, ref } : attachment)))
        } catch (error) {
          drop(`${name} didn't upload: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }
  }

  const removeAttachment = (key: string) => {
    // A limit or upload error is about the set being changed now.
    setAttachError(null)
    setAttachments((current) => current.filter((attachment) => {
      if (attachment.key === key) release(attachment)
      return attachment.key !== key
    }))
  }

  const clearDraft = () => {
    for (const attachment of attachments) release(attachment)
    setAttachments([])
    setAttachError(null)
    // A send or stash can unmount the composer before its empty state commits.
    storedDraft.text = ''
    storedDraft.images = []
    saveDraft(session.sessionId, '')
    restoredDraft.current = ''
    setDraft('')
    updateTrigger(null)
  }

  // A draft taken from the stash goes before anything typed since, with its images as fit.
  const latestAttachments = useRef(attachments)
  latestAttachments.current = attachments
  const bringBack = ({ text, images }: StashedDraft) => {
    if (text) {
      pendingCaret.current = text.length
      setDraft((current) => [text, current.trim()].filter(Boolean).join('\n\n'))
    }
    if (!images.length) return
    const fit = fitAttachments(latestAttachments.current.length, images.length)
    if (fit.error) setAttachError(fit.error)
    const restored = images.slice(0, fit.accepted).map((ref) => ({
      key: `stash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: ref.name ?? 'image',
      previewUrl: chatImageUrl(ref.id),
      ref,
    }))
    setAttachments((current) => [...restored, ...current])
  }

  const stashMenuId = useId()
  const stash = useComposerStash({
    session,
    draft,
    images,
    uploading: attachments.some((attachment) => !attachment.ref),
    clear: clearDraft,
    bringBack,
    setError: setAttachError,
  })
  const stashNow = useNow(stash.menuOpen)
  // The stash list and the `/`, `@` and `#` menus share the space; the stash list wins.
  const triggerMenuOpen = menuOpen && !stash.menuOpen
  const openStashMenu = () => {
    updateTrigger(null)
    stash.openMenu(!stash.menuOpen)
    textarea.current?.focus()
  }

  // Each send's draft is kept by its request id, so a refusal puts back what it refused
  // even after later follow-ups were sent.
  const sentDrafts = useRef(new Map<string, { text: string; images: ChatImageRef[] }>())
  useEffect(() => {
    let restored = attachments.length
    for (const { requestId, code } of sendError?.refused ?? []) {
      const sent = sentDrafts.current.get(requestId)
      if (!sent) continue
      sentDrafts.current.delete(requestId)
      if (sent.text) setDraft((current) => (current.trim() ? `${current}\n\n${sent.text}` : sent.text))
      // A missing image has to be attached again, as the error says.
      if (!sent.images.length || code === 'chat_image_missing') continue
      const fit = fitAttachments(restored, sent.images.length)
      if (fit.error) setAttachError(fit.error)
      restored += fit.accepted
      const images = sent.images.slice(0, fit.accepted).map((ref) => ({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: ref.name ?? 'image',
        previewUrl: chatImageUrl(ref.id),
        ref,
      }))
      setAttachments((current) => [...current, ...images])
    }
    // Only a new refusal restores; the attachments it reads are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendError])

  const latestDraft = useRef<ChatDraft>({ text: '', images: [] })
  latestDraft.current = { text: draft, images }
  useEffect(() => {
    if (!registerDraft) return
    registerDraft(() => latestDraft.current)
    return () => registerDraft(null)
  }, [registerDraft])

  // Back from Claude Code: what the chat held comes back into the composer, once.
  // Images beyond a message's limit stay with Commando and come back as room frees up.
  const reportedCarries = useRef(new Set<string>())
  useEffect(() => {
    // A pending switch has taken the draft as it was; what's carried stays with Commando until then.
    if (!carried || switching || reportedCarries.current.has(carried.id)) return
    let restored = takenCarries.get(carried.id)
    if (restored === undefined) {
      // The saved draft may have brought some of the carried images back already.
      const attached = new Set(images.map((ref) => ref.id))
      let room = MAX_CHAT_IMAGES - attachments.length
      const adding: ChatImageRef[] = []
      let taken = 0
      for (const ref of carried.images) {
        if (!attached.has(ref.id)) {
          if (room <= 0) break
          room -= 1
          adding.push(ref)
        }
        taken += 1
      }
      const waiting = carried.images.length - taken
      if (waiting) setAttachError(`${waiting} image${waiting === 1 ? '' : 's'} from before ${session.provider === 'codex' ? 'Codex TUI' : 'Claude Code'} ${waiting === 1 ? "doesn't" : "don't"} fit in this message yet; ${waiting === 1 ? 'it comes' : 'they come'} back once you send or remove attachments`)
      if (!carried.text && taken === 0) return
      restored = taken
      takenCarries.set(carried.id, restored)
      if (carried.text) {
        const saved = restoredDraft.current
        setDraft((current) => {
          const text = current.trim()
          // A handoff carries the saved draft, sometimes with the queue before it.
          const included = current === saved && text
            && (carried.text.trim() === text || carried.text.trim().endsWith(`\n\n${text}`))
          return [carried.text, included ? '' : text].filter(Boolean).join('\n\n')
        })
      }
      const back = adding.map((ref, index) => ({
        key: `carried-${carried.id}-${index}`,
        name: ref.name ?? 'image',
        previewUrl: chatImageUrl(ref.id),
        ref,
      }))
      if (back.length) setAttachments((current) => [...back, ...current])
    }
    reportedCarries.current.add(carried.id)
    onCarriedTaken?.(carried.id, restored)
    // A carried draft is taken once; room for its images is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried?.id, attachments.length, switching])

  const uploading = attachments.some((attachment) => !attachment.ref)
  useEffect(() => {
    if (!onUploadingChange) return
    onUploadingChange(uploading)
    return () => onUploadingChange(false)
  }, [uploading, onUploadingChange])
  const canSend = !disabled && !uploading && Boolean(draft.trim() || attachments.length)
  const planFollowUp = plan && !running && !relayTarget ? plan : undefined
  const refining = Boolean(draft.trim() || attachments.length)
  /**
   * Enter queues while Claude works (the host holds it until the turn ends);
   * ⌘Enter steers. A relay always goes now: main Claude forwards it.
   */
  const submit = (steer = false) => {
    if (!canSend) return
    const images = attachments.flatMap((attachment) => (attachment.ref ? [attachment.ref] : []))
    const options: ChatSendOptions = relayTarget
      ? { relayTo: relayTarget }
      : running && turnFlow ? { delivery: steer ? 'steer' : 'queue' } : {}
    const text = draft.trim()
    const requestId = Object.keys(options).length ? onSend(text, images, options) : images.length ? onSend(text, images) : onSend(text)
    if (requestId) {
      sentDrafts.current.set(requestId, { text, images })
      window.setTimeout(() => sentDrafts.current.delete(requestId), CHAT_SEND_REFUSAL_MS)
    }
    clearDraft()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (stash.onKeyDown(event)) return
    if (triggerMenuOpen && trigger) {
      if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        const index = active ? items.indexOf(active) : -1
        const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        setActiveKey(items[next]!.key)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss(trigger)
        return
      }
      // A fully typed command sends on Enter, as in the TUI; Tab still completes it.
      const exact = active?.type === 'command' && active.runsHere && active.command.name === trigger.query
      if (active && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !exact))) {
        event.preventDefault()
        pick(active)
        return
      }
    }
    if (handleLineKey(event, event.currentTarget)) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(event.metaKey || event.ctrlKey)
    } else if (event.key === 'Escape' && running) {
      event.preventDefault()
      interrupt()
    } else if (event.key === 'Escape' && relayTarget) {
      event.preventDefault()
      onClearRelay?.()
    }
  }

  /** Stop. As in the Claude Code TUI, queued messages come back into the composer to edit. */
  const interrupt = () => {
    if (!queue.length) {
      onInterrupt()
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
    setDraft((current) => [...taken.map((queued) => queued.text), current.trim()].filter(Boolean).join('\n\n'))
    const restored: Attachment[] = taken.flatMap((queued) => queued.images ?? []).map((image, index) => ({
      key: `queued-${index}-${image.id}`,
      name: image.name ?? image.id,
      previewUrl: chatImageUrl(image.id),
      ref: image,
    }))
    if (restored.length) setAttachments((current) => [...restored, ...current])
    if (taken.length < queue.length) setAttachError(`${queue.length - taken.length} queued message${queue.length - taken.length === 1 ? ' has' : 's have'} too many images to bring back here, so ${queue.length - taken.length === 1 ? 'it stays' : 'they stay'} queued`)
    onInterrupt(taken.map((queued) => queued.id))
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    event.preventDefault()
    addImages(images)
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    setDragging(false)
    addImages([...event.dataTransfer.files])
  }

  const shownError = attachError ?? sendError?.message ?? actionError ?? null
  const dismissError = () => {
    if (attachError) setAttachError(null)
    else if (sendError) onDismissSendError?.()
    else onDismissActionError?.()
  }
  const profile = profileLabel(session.configDir)
  const planUsage = usePlanUsage(session)
  return (
    <div className="px-4 pb-3 pt-2">
      <div
        className={cn(
          'mx-auto w-full max-w-[var(--chat-content-max-width)] overflow-hidden rounded-xl border border-input bg-card shadow-sm focus-within:border-primary/60',
          dragging && 'border-primary ring-2 ring-primary/30',
        )}
        onDragOver={onDragOver}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={onDrop}
        data-testid="chat-composer"
      >
        {relayTarget && onClearRelay ? <RelayChip provider={provider} label={relayTarget.label} onClear={onClearRelay} /> : null}
        {planFollowUp ? <PlanReadyBanner provider={provider} session={session} title={chatPlanTitle(planFollowUp.item.text)} implementMode={planFollowUp.implementMode} refining={refining} /> : null}
        {queue.length && onQueue ? (
          <QueuedMessages
            provider={provider}
            queue={queue}
            disabled={!hostConnected}
            onChange={onQueue}
            onEditOrphaned={(text) => {
              setDraft((current) => [current.trim(), text].filter(Boolean).join('\n\n'))
              setAttachError("That message was sent before your edit was saved; your edit is in the composer")
            }}
          />
        ) : null}
        {request ? (
          request.requestKind === 'question'
            ? <QuestionPanel provider={provider} key={request.requestId} request={request} disabled={!hostConnected} onAnswer={(answer) => onAnswer(request.requestId, answer)} />
            : <ApprovalPanel request={request} pendingCount={requests.length} cwd={session.cwd} disabled={!hostConnected} onAnswer={(answer) => onAnswer(request.requestId, answer)} />
        ) : null}
        {stash.menuOpen ? (
          <StashMenu
            id={stashMenuId}
            entries={stash.entries}
            activeId={stash.activeId}
            paneId={session.paneId}
            now={stashNow}
            onHighlight={stash.setActiveId}
            onRestore={stash.restore}
            onRemove={stash.remove}
          />
        ) : triggerMenuOpen && trigger ? (
          <ComposerMenu
            id={menuId}
            label={MENU_LABELS[trigger.kind]}
            groups={groups}
            activeKey={active?.key ?? null}
            status={status}
            onHighlight={setActiveKey}
            onPick={pick}
          />
        ) : null}
        {attachments.length || shownError ? (
          <div className="flex flex-col gap-1.5 px-3 pt-2.5">
            {attachments.length ? (
              <div className="flex flex-wrap gap-2" aria-label="Attached images">
                {attachments.map((attachment) => (
                  <Thumbnail
                    key={attachment.key}
                    src={attachment.previewUrl}
                    name={attachment.name}
                    busy={!attachment.ref}
                    onOpen={() => setViewing({ src: attachment.previewUrl, name: attachment.name })}
                    onRemove={() => removeAttachment(attachment.key)}
                  />
                ))}
              </div>
            ) : null}
            {shownError ? (
              <p className="flex items-start gap-1 text-xs text-destructive" role="alert">
                <span className="min-w-0 flex-1">{shownError}</span>
                <button type="button" className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={dismissError}>
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            restoredDraft.current = ''
            setDraft(event.target.value)
            syncTrigger(event.target)
          }}
          onSelect={(event) => syncTrigger(event.currentTarget)}
          onBlur={() => {
            updateTrigger(null)
            if (stash.menuOpen) stash.openMenu(false)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={!hostConnected
            ? 'Reconnecting to the agent host…'
            : switching
              ? `Switching to ${session.provider === 'codex' ? 'Codex TUI' : 'Claude Code'}…`
                : closed
                ? 'This session has ended'
                : relayTarget
                  ? `Message @${relayTarget.label} through main ${provider}…`
                  : running
                    ? turnFlow ? 'Queue a follow-up (Enter) · ⌘Enter steers now' : 'Queue a follow-up…'
                    : planFollowUp ? 'Implement the plan, or type changes to refine it' : `Ask ${provider}… / for commands, @ for files`}
          aria-label={`Message ${provider}`}
          aria-controls={stash.menuOpen ? stashMenuId : triggerMenuOpen ? menuId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={stash.menuOpen ? (stash.activeId ? `${stashMenuId}-${stash.activeId}` : undefined) : triggerMenuOpen && active ? `${menuId}-${active.key}` : undefined}
          className="chat-composer-input block max-h-60 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {richInput ? (
              <>
                <Button size="icon-sm" variant="ghost-muted" aria-label="Attach images" title="Attach images (or paste / drop them)" disabled={disabled} onClick={() => fileInput.current?.click()}>
                  <Paperclip aria-hidden="true" />
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={CHAT_IMAGE_TYPES.join(',')}
                  multiple
                  hidden
                  data-testid="chat-image-input"
                  onChange={(event) => {
                    addImages([...(event.target.files ?? [])])
                    event.target.value = ''
                  }}
                />
              </>
            ) : null}
            {/* A resumed chat replays its history before Claude starts, and can't switch until then. */}
            <ModelPicker session={session} disabled={disabled || session.status === 'starting'} onConfigure={onConfigure} open={modelMenuOpen} onOpenChange={setModelMenuOpen} />
            <PermissionPicker session={session} disabled={disabled || session.status === 'starting'} onConfigure={onConfigure} />
            {profile ? <span className="truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground" title={session.configDir}>{profile}</span> : null}
            {todos && todos.todos.length ? <TodoChip todos={todos} /> : null}
            {stash.entries.length ? (
              <Button
                size="xs"
                variant="ghost-muted"
                aria-expanded={stash.menuOpen}
                aria-haspopup="listbox"
                title="Stashed drafts (Ctrl+Shift+S). Ctrl+S stashes a draft, or brings back the newest on an empty composer"
                disabled={disabled}
                // Keep focus (and the caret) in the textarea.
                onMouseDown={(event) => event.preventDefault()}
                onClick={openStashMenu}
              >
                <Archive aria-hidden="true" />
                {stash.entries.length} stashed
              </Button>
            ) : null}
          </span>
          {planUsage ? <PlanUsageMeter usage={planUsage} profile={profile} /> : null}
          {session.contextUsage ? (
            <ContextMeter usage={session.contextUsage} canCompact={session.provider === 'claude' && !disabled && !running} onCompact={() => onSend('/compact')} />
          ) : null}
          {running ? (
            <Button size="icon-sm" variant="outline" aria-label="Stop" title={queue.length ? 'Stop (Esc): queued messages come back here' : 'Stop (Esc)'} onClick={interrupt} disabled={!hostConnected}>
              <span className="size-2.5 rounded-[2px] bg-destructive" aria-hidden="true" />
            </Button>
          ) : null}
          {running && turnFlow && !relayTarget ? (
            <Button size="icon-sm" variant="outline" aria-label="Steer now" title={`Steer now (⌘Enter): ends ${provider}'s turn at its next safe point and sends this`} onClick={() => submit(true)} disabled={!canSend}>
              <Zap aria-hidden="true" />
            </Button>
          ) : null}
          {planFollowUp && onImplement && !refining ? (
            <ImplementButton disabled={disabled} onImplement={onImplement} {...(onImplementInNewPane ? { onImplementInNewPane } : {})} />
          ) : planFollowUp && refining ? (
            <Button size="sm" onClick={() => submit()} disabled={!canSend} title={`Send your notes; ${provider} stays in plan mode`}>Refine</Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={running && turnFlow && !relayTarget ? 'Queue' : 'Send'}
              title={uploading ? 'Waiting for images to upload' : running && turnFlow && !relayTarget ? `Queue (Enter): sent when ${provider} finishes this turn` : 'Send (Enter)'}
              onClick={() => submit()}
              disabled={!canSend}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <ImageViewer image={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}
