import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const COMMANDER_CLI_FILENAME = 'commando-agents.mjs'

export function commanderDir(home = homedir()): string { return join(home, '.commando', 'commander') }
export function commanderCliPath(home = homedir()): string { return join(home, '.commando', 'hooks', COMMANDER_CLI_FILENAME) }

/** The only commands Commander may run without asking: its own CLI. */
export function commanderToolRules(cliPath: string): string[] {
  return [`Bash(node ${JSON.stringify(cliPath)}:*)`, `Bash(node ${cliPath}:*)`]
}

/**
 * Pre-approved tools for a chat started in the Commander folder. Passed straight to the SDK,
 * because Claude ignores a project's settings.json allow rules until that folder is trusted.
 */
export function commanderAllowedTools(cwd: string, home = homedir()): string[] {
  return resolve(cwd) === commanderDir(home) ? commanderToolRules(commanderCliPath(home)) : []
}
