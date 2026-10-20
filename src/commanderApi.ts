import type { CommanderRelay, CommanderState } from '../shared/commander'
import { createOwnerJsonRequest } from './webPanesApi'

export function createCommanderApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return {
    async ensure(): Promise<CommanderState> {
      const result = await request('/api/commander', { method: 'POST' }) as { ok?: boolean; state?: CommanderState; error?: string } | null
      if (!result?.ok || !result.state) throw new Error(result?.error ?? 'Unable to open Commander')
      return result.state
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
