import type { ChatProvider } from '../../shared/agent-chat.js'
import type { ChatProviderSession } from './provider.js'
import { AgentSession, type AgentSessionSpec } from './session.js'
import { which } from './which.js'
import { CodexChatSession } from './codex/session.js'
import { MuseChatSession } from './muse/session.js'

export async function createChatProviderSession(provider: ChatProvider, spec: AgentSessionSpec): Promise<ChatProviderSession> {
  switch (provider) {
    case 'claude': {
      const claudePath = spec.claudePath ?? await which('claude')
      // getSessionMessages/getSessionInfo read transcripts from the chosen profile.
      if (spec.configDir) process.env.CLAUDE_CONFIG_DIR = spec.configDir
      return new AgentSession({ ...spec, ...(claudePath ? { claudePath } : {}) })
    }
    case 'codex': {
      const codexPath = await which('codex')
      if (!codexPath) throw new Error('Codex is not installed (codex was not found on PATH)')
      return new CodexChatSession(spec, undefined, codexPath)
    }
    case 'muse': {
      const musePath = await which('muse')
      if (!musePath) throw new Error('Muse is not installed (muse was not found on PATH)')
      return new MuseChatSession(spec, undefined, musePath)
    }
  }
}
