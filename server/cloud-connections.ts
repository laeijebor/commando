import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { CloudProviderId } from '../shared/cloud-tasks.js'
import type { CloudCliRunner, CloudProviderAdapter } from './cloud-provider.js'
import { ClaudeCloudAdapter } from './cloud-providers/claude-cli.js'
import { CodexCloudAdapter } from './cloud-providers/codex-cli.js'

type Options = { env?: NodeJS.ProcessEnv; home?: string; runner?: CloudCliRunner }

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch { return false }
}

/** Resolve common installations without executing a login shell or shell aliases. */
export function resolveCloudExecutable(provider: CloudProviderId, { env = process.env, home = homedir() }: Options = {}): string {
  const override = env[provider === 'claude' ? 'COMMANDO_CLAUDE_CLI' : 'COMMANDO_CODEX_CLI']
  // Even an invalid explicit override wins: do not silently run a different binary.
  if (override !== undefined) return override
  const candidates = (env.PATH ?? '').split(delimiter).filter(isAbsolute).map((directory) => join(directory, provider))
  candidates.push(join(home, '.local', 'bin', provider))
  for (const candidate of candidates) if (executable(candidate)) return candidate
  if (provider === 'codex') {
    const root = join(env.NVM_DIR && isAbsolute(env.NVM_DIR) ? env.NVM_DIR : join(home, '.nvm'), 'versions', 'node')
    try {
      const versions = readdirSync(root).filter((name) => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => {
        const av = a.slice(1).split('.').map(Number)
        const bv = b.slice(1).split('.').map(Number)
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2]
      })
      for (const version of versions.slice(0, 50)) {
        const candidate = join(root, version, 'bin', 'codex')
        if (executable(candidate)) return candidate
      }
    } catch { /* No NVM install: preserve the normal missing-CLI readiness state. */ }
  }
  return provider
}

/** Each connection captures its own child environment; global login state is untouched. */
export function createCloudConnections({ env = process.env, home = homedir(), runner }: Options = {}): CloudProviderAdapter[] {
  const claude = resolveCloudExecutable('claude', { env, home })
  return [
    new ClaudeCloudAdapter({
      runner, executable: claude, label: 'Claude Team',
      credentialContextId: env.COMMANDO_CLOUD_CLAUDE_TEAM_CONTEXT ?? 'claude:team',
      // Unset by default: the child gets no CLAUDE_CONFIG_DIR. Set this when the
      // Team login lives in its own directory (e.g. ~/.claudew).
      configDir: env.COMMANDO_CLOUD_CLAUDE_TEAM_CONFIG_DIR ?? null,
      verifiedVersion: env.COMMANDO_CLOUD_CLAUDE_TEAM_VERIFIED_VERSION ?? '',
    }),
    new ClaudeCloudAdapter({
      runner, executable: claude, label: 'Claude Max',
      credentialContextId: env.COMMANDO_CLOUD_CLAUDE_MAX_CONTEXT ?? 'claude:max',
      configDir: env.COMMANDO_CLOUD_CLAUDE_MAX_CONFIG_DIR ?? join(home, '.claudep'),
      verifiedVersion: env.COMMANDO_CLOUD_CLAUDE_MAX_VERIFIED_VERSION ?? '',
    }),
    new CodexCloudAdapter({
      runner, executable: resolveCloudExecutable('codex', { env, home }),
      credentialContextId: env.COMMANDO_CLOUD_CODEX_CONTEXT ?? 'codex:default',
      verifiedVersion: env.COMMANDO_CLOUD_CODEX_VERIFIED_VERSION ?? '',
    }),
  ]
}
