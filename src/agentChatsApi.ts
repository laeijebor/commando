import { createOwnerJsonRequest } from './webPanesApi'

export function createAgentChatsApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return {
    answerRequest: async (id: string, decision: 'accepted' | 'dismissed'): Promise<void> => {
      const result = await request(`/api/agent-chats/requests/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) }) as { ok?: boolean; error?: string }
      if (result?.ok === false) throw new Error(result.error ?? 'Unable to open chat')
    },
    getPrepareCommand: async (root: string): Promise<string> => {
      const result = await request(`/api/repo-prepare-commands?root=${encodeURIComponent(root)}`, { method: 'GET' }) as { command: string }
      return result.command
    },
    setPrepareCommand: async (root: string, command: string): Promise<void> => {
      await request('/api/repo-prepare-commands', { method: 'PUT', body: JSON.stringify({ root, command }) })
    },
  }
}
