import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Minimize2, Zap } from 'lucide-react'
import { hostTakesSettings, selectedModelOption, type ChatContextUsage, type ChatPlanLimit, type ChatPlanUsage, type ChatSessionInfo, type ChatSettingsChange } from '../../shared/agent-chat'
import { EFFORT_LABELS, fastModeAvailable, fastModeOn, formatTokens, modelLabel, modelMenuAvailable, permissionDescription, permissionLabel, permissionModeOptions } from '../../shared/chat-composer'
import { cn } from './cn'
import { formatDuration, formatReadingAge, formatResetTime, headlineLimits, isLimitReached, isPlanUsageStale, reachedLimit, shortLimitLabel } from './planUsage'
import { Button } from './ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover'

export { providerLabel } from '../../shared/chat-composer'

function Pill({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted-foreground" title={title}>{children}</span>
}

export function PillTrigger({ label, open, disabled }: { label: string; open: boolean; disabled: boolean }) {
  return (
    <PopoverTrigger
      disabled={disabled}
      className={cn(
        'flex min-w-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-2xs disabled:cursor-default disabled:opacity-60',
        open ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      <ChevronDown className="size-2.5 shrink-0 text-icon-muted" aria-hidden="true" />
    </PopoverTrigger>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h5 className="mx-2 mt-1 mb-0.5 text-2xs font-semibold uppercase tracking-wide text-icon-muted">{children}</h5>
}

export function MenuOption({ checked, label, description, onSelect }: { checked: boolean; label: string; description?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={description}
      onClick={onSelect}
      className={cn('flex w-full min-w-0 items-baseline gap-2 rounded-[5px] px-2 py-1 text-left', checked ? 'bg-accent text-foreground' : 'text-secondary-label hover:bg-accent')}
    >
      <span className="w-3 shrink-0 self-center text-primary">{checked ? <Check className="size-3" aria-hidden="true" /> : null}</span>
      <span className="shrink-0">{label}</span>
      {description ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{description}</span> : null}
    </button>
  )
}

/** Model, effort and fast mode, after t3code's ProviderModelPicker and TraitsPicker. */
export function ModelPicker({ session, disabled, onConfigure, open: controlledOpen, onOpenChange }: {
  session: ChatSessionInfo
  disabled: boolean
  onConfigure: (change: ChatSettingsChange) => void
  /** Lets the composer's `/model` open the menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const label = modelLabel(session)
  if (!label) return null
  const fast = fastModeOn(session)
  const pill = [label, ...(session.effort ? [EFFORT_LABELS[session.effort]] : [])].join(' · ')
  if (!session.models?.length || !modelMenuAvailable(session)) return <Pill title={session.model}>{pill}{fast ? ' · Fast' : ''}</Pill>
  const selected = selectedModelOption(session)
  const efforts = selected?.efforts ?? []
  const pick = (change: ChatSettingsChange) => {
    setOpen(false)
    onConfigure(change)
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PillTrigger label={pill} open={open} disabled={disabled} />
        <PopoverPopup className="w-[300px]" aria-label="Model and effort">
          <SectionLabel>Model</SectionLabel>
          <div role="menu" aria-label="Model">
            {session.models.map((model) => (
              <MenuOption
                key={model.value}
                checked={model === selected}
                label={model.displayName}
                {...(model.description ? { description: model.description } : {})}
                onSelect={() => pick({ model: model.value })}
              />
            ))}
          </div>
          {efforts.length ? (
            <>
              <div className="mx-0.5 my-1 h-px bg-border" />
              <SectionLabel>Effort</SectionLabel>
              <div role="radiogroup" aria-label="Effort" className="mx-2 mt-0.5 mb-1.5 inline-flex overflow-hidden rounded-md border border-input">
                {efforts.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    role="radio"
                    aria-checked={session.effort === effort}
                    onClick={() => pick({ effort })}
                    className={cn('px-2 py-0.5 text-xs', session.effort === effort ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {EFFORT_LABELS[effort]}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {selected?.supportsFast ? (
            <>
              <div className="mx-0.5 my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={fast}
                onClick={() => pick({ fast: !fast })}
                className={cn('flex w-full min-w-0 items-center gap-2 rounded-[5px] px-2 py-1 text-left', fast ? 'text-foreground' : 'text-secondary-label hover:bg-accent')}
              >
                <Zap className={cn('size-3 shrink-0', fast ? 'fill-current text-primary' : 'text-icon-muted')} aria-hidden="true" />
                <span className="shrink-0">Fast mode</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Faster replies, higher usage</span>
                <span className={cn('relative h-3.5 w-6 shrink-0 rounded-full transition-colors', fast ? 'bg-primary' : 'bg-input')} aria-hidden="true">
                  <span className={cn('absolute top-0.5 size-2.5 rounded-full bg-background transition-[left]', fast ? 'left-3' : 'left-0.5')} />
                </span>
              </button>
            </>
          ) : null}
        </PopoverPopup>
      </Popover>
      {fastModeAvailable(session) ? (
        <button
          type="button"
          aria-pressed={fast}
          disabled={disabled}
          title="Fast mode: faster replies, higher usage"
          onClick={() => onConfigure({ fast: !fast })}
          className={cn(
            'flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60',
            fast ? 'border-primary/40 text-primary hover:bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <Zap className={cn('size-3 shrink-0', fast && 'fill-current')} aria-hidden="true" />
          {fast ? 'Fast on' : 'Fast off'}
        </button>
      ) : null}
    </>
  )
}

export function PermissionPicker({ session, disabled, onConfigure }: { session: ChatSessionInfo; disabled: boolean; onConfigure: (change: ChatSettingsChange) => void }) {
  const [open, setOpen] = useState(false)
  const current = session.permissionMode
  if (!current) return null
  if (!hostTakesSettings(session)) return <Pill title="Restart this chat to change its settings">{permissionLabel(current, session)}</Pill>
  const modes = permissionModeOptions(session)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PillTrigger label={permissionLabel(current, session)} open={open} disabled={disabled} />
      <PopoverPopup className="w-[300px]" aria-label="Permissions">
        <div role="menu" aria-label="Permissions">
          {modes.map((mode) => (
            <MenuOption
              key={mode}
              checked={mode === current}
              label={permissionLabel(mode, session)}
              description={permissionDescription(mode, session)}
              onSelect={() => {
                setOpen(false)
                if (mode !== current) onConfigure({ permissionMode: mode })
              }}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  )
}

function percent(part: number, whole: number): number {
  return Math.max(0, Math.min(100, (part / whole) * 100))
}

function formatPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(value)}%`
}

/** Stable colours per kind of context, so a category keeps its colour as it grows. */
function categoryColor(name: string): string {
  if (/message|conversation/i.test(name)) return 'var(--accent)'
  if (/memory|skill/i.test(name)) return 'var(--amber)'
  if (/agent/i.test(name)) return 'var(--green)'
  return 'var(--cyan)'
}

/** A ring for how full the context window is, after t3code's ContextWindowMeter. */
export function ContextMeter({ usage, canCompact, onCompact }: { usage: ChatContextUsage; canCompact: boolean; onCompact: () => void }) {
  const [open, setOpen] = useState(false)
  const used = percent(usage.usedTokens, usage.maxTokens)
  const overloaded = used > 90
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const color = overloaded ? 'var(--red)' : 'var(--accent)'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
        aria-label={`Context window ${formatPercent(used)} used`}
        data-overloaded={overloaded || undefined}
      >
        <svg viewBox="0 0 24 24" className="size-[22px] -rotate-90" aria-hidden="true">
          <circle cx="12" cy="12" r={radius} fill="none" stroke="var(--surface-hover)" strokeWidth="4" />
          <circle cx="12" cy="12" r={radius} fill="none" stroke={color} strokeWidth="4" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - used / 100)} />
        </svg>
      </PopoverTrigger>
      <PopoverPopup className="grid w-[300px] gap-2 px-3 py-2.5" side="top" align="end" aria-label="Context window">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <b className="font-semibold text-foreground">Context</b>
          <span className={cn('tabular-nums', overloaded ? 'text-destructive' : 'text-muted-foreground')}>
            {formatTokens(usage.usedTokens)} / {formatTokens(usage.maxTokens)} · {formatPercent(used)}
          </span>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-accent" role="progressbar" aria-label="Context window usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
          {usage.categories.map((category) => (
            <span key={category.name} className="block h-full" style={{ width: `${percent(category.tokens, usage.maxTokens)}%`, background: categoryColor(category.name) }} />
          ))}
        </div>
        {usage.categories.length ? (
          <div className="grid grid-cols-[10px_1fr_auto] items-center gap-x-1.5 gap-y-0.5 text-xs">
            {usage.categories.map((category) => (
              <span key={category.name} className="contents">
                <i className="block size-2 rounded-xs" style={{ background: categoryColor(category.name) }} />
                <span className="truncate">{category.name}</span>
                <span className="font-mono text-2xs text-muted-foreground">{formatTokens(category.tokens)}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {usage.autoCompact && usage.autoCompactThreshold
              ? `Auto-compacts at ${formatPercent(percent(usage.autoCompactThreshold, usage.maxTokens))}`
              : usage.autoCompact ? 'Compacts automatically' : 'Auto-compact is off'}
          </span>
          <Button size="xs" variant="outline" disabled={!canCompact} onClick={() => { setOpen(false); onCompact() }}>
            <Minimize2 aria-hidden="true" />
            Compact now
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  )
}

const SEVERITY_TEXT = { normal: '', warning: 'text-warning', critical: 'text-destructive' } as const
const SEVERITY_FILL = { normal: 'bg-primary', warning: 'bg-warning', critical: 'bg-destructive' } as const

function limitSeverity(limit: ChatPlanLimit, now: number): ChatPlanLimit['severity'] {
  if (isLimitReached(limit, now)) return 'critical'
  // A full window that has reset since the reading is open again.
  return limit.reached ? 'normal' : limit.severity
}

/** Re-renders on an interval, so reset countdowns and staleness keep up. */
function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

function resetText(limit: ChatPlanLimit, now: number): string | null {
  if (limit.resetsAt === undefined) return null
  if (limit.resetsAt <= now) return 'Reset since this reading'
  const at = formatResetTime(limit.resetsAt, now)
  return limit.resetsAt - now < 24 * 3_600_000 ? `Resets ${at} · in ${formatDuration(limit.resetsAt - now)}` : `Resets ${at}`
}

/** The plan's 5h and weekly windows as two small bars, with every window in a popover. */
export function PlanUsageMeter({ usage, profile }: { usage: ChatPlanUsage; profile: string | null }) {
  const [open, setOpen] = useState(false)
  const now = useClock(30_000)
  const reached = reachedLimit(usage, now)
  const stale = isPlanUsageStale(usage, now)
  const age = formatReadingAge(usage.updatedAt, now)
  const headline = headlineLimits(usage)
  const summary = headline.map((limit) => `${limit.title} ${Math.round(limit.percent)}% used`).join(', ')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground hover:bg-accent hover:text-secondary-label',
          open && 'bg-accent text-secondary-label',
          stale && !reached && 'opacity-50',
          reached && 'rounded-full border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive',
        )}
        aria-label={reached ? `${reached.title} limit reached` : `Plan usage: ${summary}`}
        title={reached ? undefined : `Plan usage, ${age}${stale ? ' (stale)' : ''}`}
        data-testid="plan-usage-meter"
      >
        {reached ? (
          <span>{shortLimitLabel(reached)} limit reached{reached.resetsAt !== undefined ? ` · resets ${formatResetTime(reached.resetsAt, now)}` : ''}</span>
        ) : headline.map((limit) => (
          <span key={`${limit.kind}:${limit.title}`} className={cn('flex items-center gap-1', SEVERITY_TEXT[limitSeverity(limit, now)])}>
            {shortLimitLabel(limit)}
            <span className="block h-1 w-6 overflow-hidden rounded-[2px] bg-accent" aria-hidden="true">
              <span className={cn('block h-full', SEVERITY_FILL[limitSeverity(limit, now)])} style={{ width: `${limit.percent}%` }} />
            </span>
            {Math.round(limit.percent)}%
          </span>
        ))}
      </PopoverTrigger>
      <PopoverPopup className="grid w-[300px] gap-2.5 px-3 py-2.5" side="top" align="end" aria-label="Plan usage">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <b className="font-semibold text-foreground">Plan usage</b>
          <span className="truncate text-xs text-muted-foreground">{[usage.plan && usage.plan[0]!.toUpperCase() + usage.plan.slice(1), profile].filter(Boolean).join(' · ')}</span>
        </div>
        {usage.limits.map((limit) => {
          const severity = limitSeverity(limit, now)
          const reset = resetText(limit, now)
          return (
            <div key={`${limit.kind}:${limit.title}`} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-foreground">{limit.title}</span>
                <span className={cn('tabular-nums', severity === 'normal' ? 'text-muted-foreground' : SEVERITY_TEXT[severity])}>
                  {isLimitReached(limit, now) ? 'Limit reached' : `${Math.round(limit.percent)}% used`}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-[3px] bg-accent" role="progressbar" aria-label={`${limit.title} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(limit.percent)}>
                <span className={cn('block h-full', SEVERITY_FILL[severity])} style={{ width: `${limit.percent}%` }} />
              </div>
              {reset ? <span className="text-2xs text-muted-foreground">{reset}</span> : null}
            </div>
          )
        })}
        <div className={cn('border-t border-border pt-2 text-2xs', stale ? 'text-warning' : 'text-muted-foreground')}>
          Updated {age}{stale ? ' · refreshes after the next turn' : ''}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
