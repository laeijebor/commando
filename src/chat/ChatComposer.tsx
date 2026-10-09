import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, CheckSquare, Square, SquareCheckBig } from 'lucide-react'
import type { ChatAnswer, ChatItem, ChatSessionInfo } from '../../shared/agent-chat'
import { cn } from './cn'
import { shortPath } from './timelineRows'
import { Button } from './ui/button'

type RequestItem = Extract<ChatItem, { kind: 'request' }>
type TodoItem = Extract<ChatItem, { kind: 'todo_list' }>

// Approval panel, after t3code's ComposerPendingApprovalPanel/Actions.
function ApprovalPanel({ request, pendingCount, cwd, onAnswer }: { request: RequestItem; pendingCount: number; cwd: string; onAnswer: (answer: ChatAnswer) => void }) {
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
        <Button size="xs" onClick={() => onAnswer({ kind: 'approval', decision: 'allow' })}>Allow once</Button>
        <Button size="xs" variant="outline" onClick={() => onAnswer({ kind: 'approval', decision: 'allow_always' })}>Always allow</Button>
        <Button size="xs" variant="destructive-outline" onClick={() => onAnswer({ kind: 'approval', decision: 'deny' })}>Deny</Button>
      </div>
    </div>
  )
}

// AskUserQuestion, after t3code's ComposerPendingUserInputPanel.
function QuestionPanel({ request, onAnswer }: { request: RequestItem; onAnswer: (answer: ChatAnswer) => void }) {
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
    <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto border-b border-border bg-warning-surface px-3 py-2.5" role="group" aria-label="Claude is asking">
      <span className="text-2xs font-semibold uppercase tracking-wide text-warning">Claude is asking</span>
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
              const Icon = question.multiSelect ? (active ? SquareCheckBig : Square) : active ? CheckSquare : Square
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
        <Button size="xs" disabled={!complete} onClick={() => onAnswer({ kind: 'question', answers: Object.fromEntries(questions.map((question) => [question.question, answerFor(question.question)])) })}>
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

function profileLabel(configDir: string | undefined): string | null {
  if (!configDir) return null
  const name = configDir.split('/').filter(Boolean).pop() ?? ''
  return name.replace(/^\./, '') || null
}

const PERMISSION_LABELS: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

export function ChatComposer({
  session,
  hostConnected,
  requests,
  todos,
  onSend,
  onInterrupt,
  onAnswer,
  autoFocus,
}: {
  session: ChatSessionInfo
  hostConnected: boolean
  requests: RequestItem[]
  todos?: TodoItem
  onSend: (text: string) => void
  onInterrupt: () => void
  onAnswer: (requestId: string, answer: ChatAnswer) => void
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const running = session.status === 'running' || session.status === 'waiting'
  const closed = session.status === 'closed' || session.status === 'error'
  const disabled = !hostConnected || closed
  const request = requests[0]

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [draft])

  useEffect(() => {
    if (autoFocus) textarea.current?.focus()
  }, [autoFocus])

  const submit = () => {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape' && running) {
      event.preventDefault()
      onInterrupt()
    }
  }
  const profile = profileLabel(session.configDir)
  return (
    <div className="px-4 pb-3 pt-2">
      <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] overflow-hidden rounded-xl border border-input bg-card shadow-sm focus-within:border-primary/60">
        {request ? (
          request.requestKind === 'question'
            ? <QuestionPanel key={request.requestId} request={request} onAnswer={(answer) => onAnswer(request.requestId, answer)} />
            : <ApprovalPanel request={request} pendingCount={requests.length} cwd={session.cwd} onAnswer={(answer) => onAnswer(request.requestId, answer)} />
        ) : null}
        <textarea
          ref={textarea}
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={!hostConnected ? 'Reconnecting to the agent host…' : closed ? 'This session has ended' : running ? 'Queue a follow-up…' : 'Ask Claude…'}
          aria-label="Message Claude"
          className="block max-h-60 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {session.model ? <span className="truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground">{session.model}</span> : null}
            {session.permissionMode ? <span className="truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground">{PERMISSION_LABELS[session.permissionMode] ?? session.permissionMode}</span> : null}
            {profile ? <span className="truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground" title={session.configDir}>{profile}</span> : null}
            {todos && todos.todos.length ? <TodoChip todos={todos} /> : null}
          </span>
          {running ? (
            <Button size="icon-sm" variant="outline" aria-label="Stop" title="Stop (Esc)" onClick={onInterrupt} disabled={!hostConnected}>
              <span className="size-2.5 rounded-[2px] bg-destructive" aria-hidden="true" />
            </Button>
          ) : null}
          <Button size="icon-sm" aria-label="Send" title="Send (Enter)" onClick={submit} disabled={disabled || !draft.trim()}>
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}
