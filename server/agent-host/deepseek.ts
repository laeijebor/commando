import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatModelOption } from '../../shared/agent-chat.js'
import type { AgentSessionSpec } from './session.js'

export const DEEPSEEK_MODEL = 'deepseek-flash[1m]'
export const DEEPSEEK_MODELS: ChatModelOption[] = [{
  value: DEEPSEEK_MODEL,
  resolvedModel: 'deepseek-flash',
  displayName: 'DeepSeek V4.1 Flash',
  description: '1M context · images and tools · billed by DeepSeek',
}]

/** Public routing settings can be passed as flags; the API key stays in the child environment. */
export const DEEPSEEK_RUNTIME_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_MODEL: DEEPSEEK_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
}

/** A separate Claude Code profile: no Anthropic login or transcript is reused. */
export function deepseekConfigDir(home = homedir()): string {
  return join(home, '.commando', 'deepseek')
}

export async function deepseekSessionSpec(spec: AgentSessionSpec): Promise<AgentSessionSpec> {
  const configDir = deepseekConfigDir(spec.env.HOME)
  let storedKey: unknown
  try {
    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    storedKey = settings?.env?.DEEPSEEK_API_KEY
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read DeepSeek settings at ${configDir}/settings.json`)
  }
  const key = spec.env.DEEPSEEK_API_KEY?.trim() || (typeof storedKey === 'string' ? storedKey.trim() : '')
  // Undefined values also clear inherited SDK child environment variables.
  const env = {
    ...spec.env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    ...DEEPSEEK_RUNTIME_ENV,
    ANTHROPIC_AUTH_TOKEN: key || undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  return { ...spec, claudeProvider: 'deepseek', configDir, env, model: DEEPSEEK_MODEL, effort: undefined, fast: false }
}
