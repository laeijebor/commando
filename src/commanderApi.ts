import type { ChatItem } from '../shared/agent-chat'
import type { CommanderRelay, CommanderState } from '../shared/commander'

/** A terminal agent's recent turns, or its screen when no transcript was found. */
export type CommanderTranscript = { source: 'transcript' | 'screen'; items: ChatItem[]; screen?: string }
import { createOwnerJsonRequest } from './webPanesApi'

export function createCommanderApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return {
    async ensure(): Promise<CommanderState> {
      const result = await request('/api/commander', { method: 'POST' }) as { ok?: boolean; state?: CommanderState; error?: string } | null
      if (!result?.ok || !result.state) throw new Error(result?.error ?? 'Unable to open Commander')
      return result.state
    },
    async transcript(paneId: string): Promise<CommanderTranscript> {
      const result = await request(`/api/commander/transcript?pane=${encodeURIComponent(paneId)}`, { method: 'GET' }) as ({ ok?: boolean; error?: string } & Partial<CommanderTranscript>) | null
      if (!result?.ok || !result.source) throw new Error(result?.error ?? 'Unable to read the transcript')
      return { source: result.source, items: result.items ?? [], ...(result.screen !== undefined ? { screen: result.screen } : {}) }
    },
    async relay(paneId: string, text: string): Promise<CommanderRelay> {
      const result = await request('/api/commander/relays', {
        method: 'POST', body: JSON.stringify({ paneId, text, delivery: 'queue' }),
      }) as { ok?: boolean; relay?: CommanderRelay; error?: string } | null
      if (!result?.ok || !result.relay) throw new Error(result?.error ?? 'Unable to relay message')
      return result.relay
    },
  }
}
