/**
 * Agent profile paths resolve from the environment, so an inherited CLAUDE_CONFIG_DIR,
 * CODEX_HOME or COMMANDO_AGENT_HOOK_TOKEN_PATH makes a test that stubs only HOME write into
 * the developer's real profile: hook settings get rewritten to point at a temporary bridge
 * the test then deletes, and every later agent session fails the hook with MODULE_NOT_FOUND.
 * Scrubbing the variables keeps resolution on the test's own HOME.
 */
export const SANDBOXED_AGENT_PROFILE_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COMMANDO_AGENT_HOOK_TOKEN_PATH',
] as const

for (const name of SANDBOXED_AGENT_PROFILE_ENV) delete process.env[name]
