import type { ChatProvider } from '../../shared/agent-chat.js'
import type { ChatProviderSession } from './provider.js'
import { AgentSession, type AgentSessionSpec } from './session.js'
import { which } from './which.js'

export async function createChatProviderSession(provider: ChatProvider, spec: AgentSessionSpec): Promise<ChatProviderSession> {
  switch (provider) {
    case 'claude': {
      const claudePath = spec.claudePath ?? await which('claude')
      // getSessionMessages/getSessionInfo read transcripts from the chosen profile.
      if (spec.configDir) process.env.CLAUDE_CONFIG_DIR = spec.configDir
      return new AgentSession({ ...spec, ...(claudePath ? { claudePath } : {}) })
    }
    case 'codex':
      throw new Error('Codex chat is not available yet')
  }
}
