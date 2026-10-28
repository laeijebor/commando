import { ChevronDown, Clock, Shield } from 'lucide-react'
import { useState } from 'react'
import type { ChatModelOption } from '../shared/agent-chat'
import type { ChatPermissionMode } from '../shared/tmux-create'
import { MenuOption, SectionLabel } from './chat/ComposerControls'
import { cn } from './chat/cn'
import { Popover, PopoverPopup, PopoverTrigger } from './chat/ui/popover'
import { relativeAge, type AgentOption, type StartWith } from './newSessionAgents'

const PILL = 'tmux-create__pill'

function agentKey(option: Pick<AgentOption, 'provider' | 'configDir'>): string {
  return option.configDir ? `${option.provider}@${option.configDir}` : option.provider
}

function providerClass(provider: StartWith): string {
  return `tmux-create__dot is-${provider.replace(/-chat$/u, '')}`
}

/** One menu for what the session starts with, Claude profiles listed inline. */
export function AgentPicker({ options, provider, configDir, disabled, onPick }: {
  options: readonly AgentOption[]
  provider: StartWith
  configDir: string | undefined
  disabled: boolean
  onPick: (option: AgentOption) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.provider === provider && (!option.configDir || option.configDir === configDir))
    ?? options.find((option) => option.provider === provider)
  const label = current ? current.label : 'Choose an agent'
  const groups = (['Chat', 'Terminal', 'Other'] as const).map((group) => ({ group, options: options.filter((option) => option.group === group) }))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} className={cn(PILL, open && 'is-open')} aria-label={`Agent: ${label}${current?.tag ? ` (${current.tag})` : ''}`}>
        <span className={providerClass(provider)} aria-hidden="true" />
        <span className="tmux-create__pill-text">{label}</span>
        {current?.tag ? <span className="tmux-create__pill-tag">{current.tag}</span> : null}
        <ChevronDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup className="w-[260px]" side="bottom" aria-label="Agent">
        {groups.map(({ group, options: rows }) => rows.length ? (
          <div key={group} role="menu" aria-label={group}>
            <SectionLabel>{group}</SectionLabel>
            {rows.map((option) => (
              <MenuOption
                key={agentKey(option)}
                checked={current ? agentKey(option) === agentKey(current) : false}
                label={option.tag ? `${option.label} · ${option.tag}` : option.label}
                onSelect={() => {
                  setOpen(false)
                  onPick(option)
                }}
              />
            ))}
          </div>
        ) : null)}
      </PopoverPopup>
    </Popover>
  )
}

/** The models this agent's provider offered in its latest chat, remembered by the daemon. */
export function NewSessionModelPicker({ models, selected, updatedAt, disabled, onPick }: {
  models: readonly ChatModelOption[]
  selected: string
  /** When the list was last seen; absent before any chat of this provider has run. */
  updatedAt: number | undefined
  disabled: boolean
  onPick: (model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = models.find((model) => model.value === selected) ?? models[0]
  const label = current?.value === 'default' ? 'Default model' : current?.displayName ?? 'Default model'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} className={cn(PILL, open && 'is-open')} aria-label={`Model: ${label}`}>
        <span className="tmux-create__pill-text">{label}</span>
        <ChevronDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup className="w-[300px]" side="bottom" aria-label="Model">
        <SectionLabel>Model</SectionLabel>
        <div role="menu" aria-label="Model">
          {models.map((model) => (
            <MenuOption
              key={model.value}
              checked={model.value === current?.value}
              label={model.displayName}
              {...(model.description ? { description: model.description } : {})}
              onSelect={() => {
                setOpen(false)
                onPick(model.value)
              }}
            />
          ))}
        </div>
        <p className="tmux-create__menu-foot">
          <Clock aria-hidden="true" />
          {updatedAt ? `From this agent's last chat, ${relativeAge(updatedAt)}` : 'The full list appears after the first chat with this agent'}
        </p>
      </PopoverPopup>
    </Popover>
  )
}

export function NewSessionPermissionPicker({ modes, selected, disabled, onPick }: {
  modes: readonly { value: ChatPermissionMode; label: string }[]
  selected: ChatPermissionMode
  disabled: boolean
  onPick: (mode: ChatPermissionMode) => void
}) {
  const [open, setOpen] = useState(false)
  const current = modes.find((mode) => mode.value === selected) ?? modes[0]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} className={cn(PILL, open && 'is-open')} aria-label={`Permissions: ${current?.label ?? ''}`} title={current?.label}>
        <Shield aria-hidden="true" />
        <span className="tmux-create__pill-text">{current?.label}</span>
      </PopoverTrigger>
      <PopoverPopup className="w-[240px]" side="bottom" aria-label="Permissions">
        <div role="menu" aria-label="Permissions">
          {modes.map((mode) => (
            <MenuOption
              key={mode.value}
              checked={mode.value === current?.value}
              label={mode.label}
              onSelect={() => {
                setOpen(false)
                onPick(mode.value)
              }}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
