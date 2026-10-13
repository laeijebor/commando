import type { ChatItem, ChatSessionInfo, ChatState } from '@commando/agent-chat'
import type { ServerMessage } from '@commando/protocol'

import type { DaemonClient, OutgoingMessage } from '../daemon/client'

let counter = 0

/** A chat item with the base fields filled in. */
export function item<T extends ChatItem['kind']>(kind: T, fields: Omit<Extract<ChatItem, { kind: T }>, 'id' | 'turnId' | 'status' | 'createdAt' | 'updatedAt' | 'kind'> & Partial<Pick<ChatItem, 'id' | 'turnId' | 'status' | 'createdAt' | 'updatedAt'>>): ChatItem {
  counter += 1
  return { id: `i${counter}`, turnId: 't1', status: 'completed', createdAt: 1_000, updatedAt: 1_000, kind, ...fields } as unknown as ChatItem
}

export function session(fields: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    paneId: '%7',
    provider: 'claude',
    cwd: '/Users/me/dev/commando',
    status: 'idle',
    hostPid: 42,
    hostVersion: 5,
    permissionMode: 'default',
    models: [
      { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] },
      { value: 'claude-opus-5-5', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] },
      { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
    ],
    model: 'claude-opus-5-5',
    effort: 'high',
    ...fields,
  }
}

export function chatState(fields: Partial<ChatState> = {}): ChatState {
  return { paneId: '%7', session: session(), items: [], hostConnected: true, ...fields }
}

/** A stand-in for the shared socket: records what was sent and replays server messages. */
export function fakeClient(options: { open?: boolean } = {}) {
  const sent: (OutgoingMessage & { requestId: string })[] = []
  const listeners = new Set<(message: ServerMessage) => void>()
  let ids = 0
  const client = {
    connected: options.open ?? true,
    send(message: OutgoingMessage): string | null {
      if (!client.connected) return null
      ids += 1
      const requestId = message.requestId ?? `r${ids}`
      sent.push({ ...message, requestId })
      return requestId
    },
    subscribe(listener: (message: ServerMessage) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(message: ServerMessage) {
      for (const listener of [...listeners]) listener(message)
    },
    sent,
    last(type: string) {
      return [...sent].reverse().find((message) => message.type === type)
    },
  }
  return client as typeof client & DaemonClient
}
