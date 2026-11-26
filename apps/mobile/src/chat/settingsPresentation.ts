import { hostTakesSettings, selectedModelOption, type ChatSessionInfo } from '@commando/agent-chat'
import { permissionLabel, permissionModeOptions } from '@commando/chat-composer'
import { chatPermissionModes, type ChatLaunchProvider } from '@commando/tmux-create'

function launchProviderFor(provider: ChatSessionInfo['provider']): ChatLaunchProvider | undefined {
  switch (provider) {
    case 'claude': return 'claude-chat'
    case 'codex': return 'codex-chat'
    case 'muse': return 'muse-chat'
    case 'cursor': return 'cursor-chat'
    default: return undefined
  }
}

export function settingsPresentation(session: ChatSessionInfo) {
  const launch = launchProviderFor(session.provider)
  const supported = Boolean(launch && hostTakesSettings(session))
  const modes = supported ? permissionModeOptions(session) : []
  const labels = launch ? chatPermissionModes(launch) : []
  const label = (mode: string) => labels.find((option) => option.value === mode)?.label ?? permissionLabel(mode, session)
  return { modes, label, efforts: supported ? selectedModelOption(session)?.efforts ?? [] : [], showPermission: Boolean(launch && session.permissionMode) }
}
