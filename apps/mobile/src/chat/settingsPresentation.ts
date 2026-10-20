import { hostTakesSettings, selectedModelOption, type ChatSessionInfo } from '@commando/agent-chat'
import { permissionLabel, permissionModeOptions } from '@commando/chat-composer'
import { chatPermissionModes, type ChatLaunchProvider } from '@commando/tmux-create'

export function settingsPresentation(session: ChatSessionInfo) {
  const launch: ChatLaunchProvider | undefined = session.provider === 'claude' ? 'claude-chat' : session.provider === 'codex' ? 'codex-chat' : session.provider === 'muse' ? 'muse-chat' : undefined
  const supported = Boolean(launch && hostTakesSettings(session))
  const modes = supported ? permissionModeOptions(session) : []
  const labels = launch ? chatPermissionModes(launch) : []
  const label = (mode: string) => labels.find((option) => option.value === mode)?.label ?? permissionLabel(mode, session)
  return { modes, label, efforts: supported ? selectedModelOption(session)?.efforts ?? [] : [], showPermission: Boolean(launch && session.permissionMode) }
}
