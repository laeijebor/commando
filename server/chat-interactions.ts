import type { ChatAnswer, ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { AgentInteractionAnswer } from '../shared/protocol.js'
import type { ChatInteractions } from './agent-host-hub.js'
import type { AgentInteractionBroker } from './agent-interaction-broker.js'
import { MAX_OPTION_LABEL_LENGTH, type AgentStatusChange, type AgentStatusRegistry, type ChatHostReport } from './agent-status-registry.js'

/**
 * Chat panes in the places that answer terminal agents' requests (island,
 * phone, push, the web HUD): a chat request in their shape, their answer in
 * the host's, and the host's status as the HUD shows it.
 */

export type ChatRequestItem = Extract<ChatItem, { kind: 'request' }>

/** True while the host still waits on the request. */
export function chatRequestOpen(item: ChatRequestItem): boolean {
  return item.status === 'running' && !item.answer
}

/**
 * The request as an `AgentInteractionRequest` (before the registry bounds
 * it), plus the attention line the HUD shows. Every question takes a typed
 * answer, as in the chat.
 */
export function chatInteraction(item: ChatRequestItem): { request: Record<string, unknown>; attention: string } {
  const questions = item.questions?.map((question) => ({
    ...(question.header ? { header: question.header } : {}),
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect,
    custom: true,
  }))
  const prompt = item.requestKind === 'approval' ? item.detail ?? item.title : questions?.[0]?.question ?? item.title
  return {
    request: {
      id: item.requestId,
      kind: item.requestKind === 'approval' ? 'permission' : 'question',
      prompt,
      toolName: item.toolName,
      ...(questions?.length ? { questions } : {}),
    },
    attention: item.requestKind === 'approval' ? item.title : prompt,
  }
}

/** An island, phone or HUD answer as the host takes it; null when it doesn't fit the request. */
export function chatAnswerFor(item: ChatRequestItem, answer: AgentInteractionAnswer): ChatAnswer | null {
  if (item.requestKind === 'approval') {
    if (answer.action === 'allow_once') return { kind: 'approval', decision: 'allow' }
    if (answer.action === 'allow_always' || answer.action === 'deny') return { kind: 'approval', decision: answer.action }
    return null
  }
  // A dismissed question goes to Claude as a denial, as from a terminal pane.
  if (answer.action === 'reject') return { kind: 'approval', decision: 'deny', message: 'The user dismissed the question.' }
  const questions = item.questions ?? []
  if (answer.action !== 'answer' || answer.answers?.length !== questions.length) return null
  return {
    kind: 'question',
    answers: Object.fromEntries(questions.map((question, index) => [
      question.question,
      answer.answers![index].map((value) => optionLabel(question.options, value)).join(', '),
    ])),
  }
}

/** The island and HUD send an option's label as listed, which may be cut short; Claude gets it whole. */
function optionLabel(options: readonly { label: string }[], value: string): string {
  const listed = (label: string) => label.replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION_LABEL_LENGTH)
  return options.find((option) => option.label === value)?.label ??
    options.find((option) => listed(option.label) === value)?.label ??
    value
}

/**
 * The host's session status for the HUD. Idle means done once the chat has had
 * a turn; before that it just waits. A closed session reports nothing.
 */
export function chatHostReport(session: ChatSessionInfo, hadTurn: boolean): ChatHostReport | null {
  const status = session.status === 'running'
    ? 'working'
    : session.status === 'waiting'
      ? 'needs_input'
      : session.status === 'error'
        ? 'failed'
        : session.status === 'idle' && hadTurn
          ? 'done'
          : session.status === 'closed' ? null : 'unknown'
  if (!status) return null
  return {
    status,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.title ? { title: session.title } : {}),
  }
}

type BrokerChatInteractionsDependencies = {
  registry: Pick<AgentStatusRegistry, 'applyChatHost' | 'openChatRequest' | 'closeChatRequest'>
  broker: Pick<AgentInteractionBroker, 'offer' | 'cancel'>
  /** `restored`: what the host already had when it (re)connected, not news to push. */
  publish: (change: AgentStatusChange, restored?: boolean) => void
  /** Hands an island, phone or HUD answer to the chat's host (`AgentHostHub.answerInteraction`). */
  answer: (paneId: string, chatRequestId: string, answer: AgentInteractionAnswer) => boolean
  log?: (message: string) => void
}

/**
 * Lists chat requests in the approvals broker and the status registry, the
 * two places a terminal agent's requests reach the island, phone, push and
 * the HUD from. An answer from any of them goes back to the chat's host.
 */
export function brokerChatInteractions(dependencies: BrokerChatInteractionsDependencies): ChatInteractions {
  const { registry, broker, publish } = dependencies
  return {
    status: (paneId, report, restored) => publish(registry.applyChatHost(paneId, report), restored),
    open: (paneId, item, restored) => {
      const { request, attention } = chatInteraction(item)
      const opened = registry.openChatRequest(paneId, request, attention)
      if (!opened) return
      broker.offer(paneId, opened.request, (answer) => {
        if (!dependencies.answer(paneId, item.requestId, answer)) {
          dependencies.log?.(`[agent-host] ${paneId} could not take an answer to ${item.requestId}`)
        }
      })
      publish(opened.change, restored)
    },
    close: (paneId, requestId) => {
      broker.cancel(paneId, requestId)
      publish(registry.closeChatRequest(paneId, requestId))
    },
  }
}
