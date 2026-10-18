import { randomBytes } from 'node:crypto'
import { StdioRpcClient, type StdioRpcClientOptions, type StdioRpcTransport } from '../rpc-client.js'

/**
 * The MSP methods this chat calls (`muse serve`, schema version 1). Regenerate the
 * reference bindings with: muse schema generate-ts --out /tmp/muse-schema
 * Incoming payloads stay unknown until checked: the schema's enums are open.
 */
export interface MuseMethods {
  'session/start': { commandId: string; workspaceRoot: string; approvalMode: MuseApprovalMode; modelId?: string }
  'session/resume': { commandId: string; sessionId: string; history: 'auto' }
  'turn/start': { sessionId: string; commandId: string; input: MuseInput[]; displayText?: string; ifBusy?: 'queue' | 'steer'; reasoningEffort?: string }
  'turn/interrupt': { sessionId: string; commandId: string; turnId?: string }
  'approval/decide': { sessionId: string; commandId: string; approvalId: string; choiceId: string; requirementId: unknown }
  'approval/listPending': { sessionId: string }
  'userInput/answer': { sessionId: string; commandId: string; userInputId: string; answers: MuseUserInputAnswer[] }
  'userInput/cancel': { sessionId: string; commandId: string; userInputId: string }
  'session/setModel': { sessionId: string; commandId: string; model: { modelId: string } }
  'session/setReasoningEffort': { sessionId: string; commandId: string; reasoningEffort: string }
  'session/setApprovalMode': { sessionId: string; commandId: string; mode: MuseApprovalMode }
  'model/list': { sessionId?: string }
  'skill/list': { sessionId: string }
}

export type MuseApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched'
export type MuseInput =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64Data: string }
  | { type: 'skill'; selector: string; arguments?: string }
export interface MuseUserInputAnswer { questionId: string; selectedLabel?: string; selectedLabels?: string[]; freeText?: string }

export type MuseTransport = StdioRpcTransport<MuseMethods>

/** Muse refuses any other command id: every state-changing call needs a fresh UUIDv7. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One owned `muse serve` child, which keeps its sessions on disk so they can be resumed. */
export class MuseRpcClient extends StdioRpcClient<MuseMethods> {
  constructor(options: StdioRpcClientOptions) {
    super({ killGraceMs: 3000, ...options }, {
      label: 'Muse',
      executable: 'muse',
      // Like Claude and Codex chats, load the workspace's own rules and skills.
      args: ['serve', '--trust-workspace'],
      jsonrpc: true,
      initialize: { clientInfo: { name: 'commando', title: 'Commando', version: '1' }, capabilities: {} },
    })
  }
}
