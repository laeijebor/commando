import { AGENT_PROFILE_ROUTES, type AgentProfilesResponse, type ClaudeProfilePreferenceChange } from '../shared/agent-profiles'
import type { TmuxCreateResponse } from '../shared/tmux-create'
import { createOwnerJsonRequest } from './webPanesApi'

export type AgentProfilesApi = ReturnType<typeof createAgentProfilesApi>

export function createAgentProfilesApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return {
    /** `refresh` asks every CLI again instead of using the daemon's cached answer. */
    list: async (refresh = false): Promise<AgentProfilesResponse> =>
      await request(`${AGENT_PROFILE_ROUTES.list}${refresh ? '?refresh=1' : ''}`, { method: 'GET' }) as AgentProfilesResponse,
    updateClaude: async (change: ClaudeProfilePreferenceChange): Promise<void> => {
      await request(AGENT_PROFILE_ROUTES.claudePreferences, { method: 'PUT', body: JSON.stringify(change) })
    },
    addClaude: async (name: string, label?: string): Promise<string> =>
      (await request(AGENT_PROFILE_ROUTES.claude, { method: 'POST', body: JSON.stringify({ name, ...(label ? { label } : {}) }) }) as { configDir: string }).configDir,
    loginClaude: async (configDir: string): Promise<TmuxCreateResponse> =>
      await request(AGENT_PROFILE_ROUTES.claudeLogin, { method: 'POST', body: JSON.stringify({ configDir }) }) as TmuxCreateResponse,
  }
}
