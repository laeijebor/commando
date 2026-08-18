import { installAgentStatusHooks } from '../server/agent-hook-installer.js'

const installed = await installAgentStatusHooks()

console.log(`Commando agent hooks installed:
  Claude settings: ${installed.claudeSettingsPath}
  Claude bridge: ${installed.claudeBridgePath}
  OpenCode plugin: ${installed.openCodePluginPath}
  Session update CLI: ${installed.sessionBriefCliPath}
  PR marker CLI: ${installed.prMarkerCliPath}
  Hook token: ${installed.tokenPath}`)
