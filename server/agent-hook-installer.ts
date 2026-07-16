import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AGENT_HOOK_TOKEN_PATH_ENV, AgentHookTokenStore } from './agent-hook-token.js'

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

export const OPENCODE_HOOK_EVENTS = [
  'session.status',
  'session.idle',
  'session.error',
  'session.deleted',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
] as const

const CLAUDE_HOOK_MARKER = '--commando-agent-status-hook'
const CLAUDE_BRIDGE_FILENAME = 'commando-claude-agent-status.mjs'
const OPENCODE_PLUGIN_FILENAME = 'commando-agent-status.js'

type JsonObject = Record<string, unknown>

export type AgentHookInstallerOptions = {
  claudeBridgePath?: string
  claudeSettingsPath?: string
  home?: string
  openCodePluginPath?: string
  tokenPath?: string
}

export type AgentHookInstallResult = {
  claudeBridgePath: string
  claudeSettingsPath: string
  openCodePluginPath: string
  tokenPath: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function existingFileMode(path: string, fallback: number): Promise<number> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`${path} must not be a symbolic link`)
    }
    if (!metadata.isFile()) throw new Error(`${path} must be a regular file`)
    return metadata.mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const metadata = await lstat(path)
    if (!metadata.isSymbolicLink() && metadata.isFile()) {
      if ((await readFile(path, 'utf8')) === content) {
        await chmod(path, mode)
        return
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function generatedClaudeBridge(tokenPath: string): string {
  return `import { readFile } from 'node:fs/promises'

async function main() {
  try {
    const pane = process.env.TMUX_PANE
    if (!pane || !/^%\\d+$/.test(pane)) return
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length < 32) return
    const port = process.env.COMMANDO_PORT || '4310'
    if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    const input = JSON.parse(await readFile(0, 'utf8'))
    const body = JSON.stringify({
      hook_event_name: input.hook_event_name,
      session_id: input.session_id,
      tool_name: input.tool_name,
      notification_type: input.notification_type,
    })
    await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/claude\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body,
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Agent hooks must never interrupt Claude Code when Commando is unavailable.
  }
}

await main()
`
}

function generatedOpenCodePlugin(tokenPath: string): string {
  return `import { readFile } from 'node:fs/promises'

const trackedEvents = new Set(${JSON.stringify(OPENCODE_HOOK_EVENTS)})

export const CommandoAgentStatusPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    if (!trackedEvents.has(event.type)) return
    try {
      const pane = process.env.TMUX_PANE
      if (!pane || !/^%\\d+$/.test(pane)) return
      const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
      if (token.length < 32) return
      const port = process.env.COMMANDO_PORT || '4310'
      if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
      const source = event.properties || {}
      const info = source.info && typeof source.info === 'object'
        ? { id: source.info.id }
        : undefined
      const properties = {
        sessionID: source.sessionID,
        status: source.status,
        id: source.id,
        requestID: source.requestID,
        info,
      }
      await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/opencode\`, {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`,
          'Content-Type': 'application/json',
          'X-Commando-Pane': pane,
        },
        body: JSON.stringify({ directory, event: { type: event.type, properties } }),
        signal: AbortSignal.timeout(1000),
      })
    } catch {
      // Status reporting is best-effort and must not block OpenCode.
    }
  },
})
`
}

function isInstalledClaudeHook(value: unknown, bridgePath: string): boolean {
  if (!isObject(value) || value.type !== 'command' || value.command !== 'node') return false
  if (!Array.isArray(value.args)) return false
  return value.args.includes(CLAUDE_HOOK_MARKER) || value.args[0] === bridgePath
}

function removeInstalledClaudeHooks(entry: unknown, bridgePath: string): unknown | null {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return entry
  const hooks = entry.hooks.filter((hook) => !isInstalledClaudeHook(hook, bridgePath))
  if (hooks.length === entry.hooks.length) return entry
  if (hooks.length === 0 && Object.keys(entry).every((key) => key === 'hooks' || key === 'matcher')) {
    return null
  }
  return { ...entry, hooks }
}

function mergeClaudeHooks(settings: JsonObject, bridgePath: string): JsonObject {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new Error('Claude settings "hooks" must be an object')
  }
  const hooks: JsonObject = settings.hooks ?? {}

  for (const event of CLAUDE_HOOK_EVENTS) {
    const configured = hooks[event]
    if (configured !== undefined && !Array.isArray(configured)) {
      throw new Error(`Claude settings hook "${event}" must be an array`)
    }
    const entries = (configured ?? [])
      .map((entry) => removeInstalledClaudeHooks(entry, bridgePath))
      .filter((entry) => entry !== null)
    entries.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'node',
        args: [bridgePath, CLAUDE_HOOK_MARKER],
      }],
    })
    hooks[event] = entries
  }

  settings.hooks = hooks
  return settings
}

async function readClaudeSettings(path: string): Promise<{ mode: number; settings: JsonObject }> {
  const mode = await existingFileMode(path, 0o600)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`)
    return { mode, settings: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode, settings: {} }
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${path} contains invalid JSON`, { cause: error })
    }
    throw error
  }
}

export class AgentHookInstaller {
  readonly paths: AgentHookInstallResult

  constructor(options: AgentHookInstallerOptions = {}) {
    const home = options.home ?? process.env.HOME
    if (!home) throw new Error('HOME is required to install agent hooks')
    const resolvedHome = resolve(home)
    const configuredTokenPath = options.tokenPath
      ?? (options.home === undefined ? process.env[AGENT_HOOK_TOKEN_PATH_ENV] : undefined)
    this.paths = {
      tokenPath: resolve(
        configuredTokenPath
          ?? resolve(resolvedHome, '.commando', 'agent-hook-token'),
      ),
      claudeBridgePath: resolve(
        options.claudeBridgePath
          ?? resolve(resolvedHome, '.commando', 'hooks', CLAUDE_BRIDGE_FILENAME),
      ),
      claudeSettingsPath: resolve(
        options.claudeSettingsPath ?? resolve(resolvedHome, '.claude', 'settings.json'),
      ),
      openCodePluginPath: resolve(
        options.openCodePluginPath
          ?? resolve(resolvedHome, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILENAME),
      ),
    }
  }

  async install(): Promise<AgentHookInstallResult> {
    await new AgentHookTokenStore({ path: this.paths.tokenPath }).loadOrCreate()
    await mkdir(dirname(this.paths.claudeBridgePath), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.paths.claudeBridgePath), 0o700)
    await writeAtomically(
      this.paths.claudeBridgePath,
      generatedClaudeBridge(this.paths.tokenPath),
      0o600,
    )
    await writeAtomically(
      this.paths.openCodePluginPath,
      generatedOpenCodePlugin(this.paths.tokenPath),
      0o600,
    )

    const { mode, settings } = await readClaudeSettings(this.paths.claudeSettingsPath)
    const merged = mergeClaudeHooks(settings, this.paths.claudeBridgePath)
    await writeAtomically(
      this.paths.claudeSettingsPath,
      `${JSON.stringify(merged, null, 2)}\n`,
      mode,
    )
    return { ...this.paths }
  }
}

export async function installAgentStatusHooks(
  options: AgentHookInstallerOptions = {},
): Promise<AgentHookInstallResult> {
  return new AgentHookInstaller(options).install()
}
