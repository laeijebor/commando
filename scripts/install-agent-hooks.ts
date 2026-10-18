import { installAgentStatusHooks } from '../server/agent-hook-installer.js'

const installed = await installAgentStatusHooks()

console.log(`Commando agent hooks installed:
  Cursor hooks: ${installed.cursorHooksPath}
  Cursor bridge: ${installed.cursorBridgePath}
  Claude settings: ${installed.claudeSettingsPath}
  Claude bridge: ${installed.claudeBridgePath}
  Codex config: ${installed.codexConfigPath}
  Codex notify bridge: ${installed.codexBridgePath}
  Muse settings: ${installed.museHooksInstalled ? installed.museSettingsPath : 'skipped (Muse has not been run yet)'}
  Muse bridge: ${installed.museBridgePath}
  OpenCode plugin: ${installed.openCodePluginPath}
  Session update CLI: ${installed.sessionBriefCliPath}
  PR marker CLI: ${installed.prMarkerCliPath}
  Hook token: ${installed.tokenPath}`)

if (installed.codexNotifyWarning) {
  console.warn(`
Codex notify was not changed: ${installed.codexNotifyWarning}
Add Commando by hand, keeping your own notifier, for example:
  notify = ["node", "${installed.codexBridgePath}"]`)
}
