import type {
  AgentProvider,
  AgentStatus,
  AgentStatusKind,
} from '../shared/protocol.js'

export type AgentStatusInput = {
  paneId: string
  command: string
  title: string
  content: string
  dead?: boolean
  capturedAt: number
  lastChangedAt: number
}

export type AgentProcessStatusInput = Pick<
  AgentStatusInput,
  'paneId' | 'command' | 'title' | 'dead' | 'capturedAt'
>

type ProviderEvidence = {
  provider: AgentProvider
  source: 'heuristic' | 'process'
  reason: string
}

const PROVIDERS: Exclude<AgentProvider, 'unknown'>[] = [
  'claude',
  'codex',
  'opencode',
]

function providerIn(value: string): Exclude<AgentProvider, 'unknown'> | null {
  const normalized = value.toLowerCase()
  for (const provider of PROVIDERS) {
    const pattern = new RegExp(`(?:^|[/\\s._-])${provider}(?:$|[\\s._-])`, 'i')
    if (pattern.test(normalized)) return provider
  }
  return null
}

export function inferAgentProvider(
  command: string,
  title: string,
  content: string,
): ProviderEvidence {
  const commandProvider = providerIn(command)
  if (commandProvider) {
    return {
      provider: commandProvider,
      source: 'process',
      reason: `foreground command identifies ${commandProvider}`,
    }
  }

  const titleProvider = providerIn(title)
  if (titleProvider) {
    return {
      provider: titleProvider,
      source: 'heuristic',
      reason: `pane title identifies ${titleProvider}`,
    }
  }

  const tail = content.slice(-12_000)
  const contentProvider = providerIn(tail)
  if (contentProvider) {
    return {
      provider: contentProvider,
      source: 'heuristic',
      reason: `recent pane output identifies ${contentProvider}`,
    }
  }

  return {
    provider: 'unknown',
    source: 'heuristic',
    reason: 'no supported agent signature found',
  }
}

// Claude Code names its process after its running version (tmux then reports
// `pane_current_command` as e.g. `2.1.263`) and prefixes the pane title with ✳.
const VERSION_PROCESS_NAME = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/u
const CLAUDE_TITLE_MARKER = /^\s*✳/u

export function claudeVersionProcessEvidence(
  command: string,
  title: string,
): ProviderEvidence | null {
  if (!VERSION_PROCESS_NAME.test(command.trim()) || !CLAUDE_TITLE_MARKER.test(title)) return null
  return {
    provider: 'claude',
    source: 'heuristic',
    reason: 'version-named process with the Claude Code pane title marker',
  }
}

export function inferAgentProcessStatus(input: AgentProcessStatusInput): AgentStatus {
  const commandEvidence = inferAgentProvider(input.command, '', '')
  const runtimeCanUseTitle = /(?:^|\/)(?:node|bun|deno|python\d*(?:\.\d+)?)$/i.test(
    input.command.trim(),
  )
  const evidence = commandEvidence.provider !== 'unknown'
    ? commandEvidence
    : claudeVersionProcessEvidence(input.command, input.title)
      ?? (runtimeCanUseTitle ? inferAgentProvider(input.command, input.title, '') : commandEvidence)
  const provider = evidence.provider
  const knownProvider = provider !== 'unknown'
  return {
    paneId: input.paneId,
    provider,
    status: input.dead && knownProvider ? 'failed' : 'unknown',
    summary: input.dead && knownProvider
      ? `${provider} process exited`
      : knownProvider ? `${provider} process detected` : 'No supported agent detected',
    source: input.dead && knownProvider ? 'process' : evidence.source,
    confidence: input.dead && knownProvider
      ? 'high'
      : evidence.source === 'process' ? 'medium' : 'low',
    reason: input.dead && knownProvider
      ? 'tmux reports the pane process as dead'
      : evidence.reason,
    updatedAt: input.capturedAt,
  }
}

function result(
  input: AgentStatusInput,
  provider: AgentProvider,
  status: AgentStatusKind,
  summary: string,
  source: AgentStatus['source'],
  confidence: AgentStatus['confidence'],
  reason: string,
): AgentStatus {
  return {
    paneId: input.paneId,
    provider,
    status,
    summary,
    source,
    confidence,
    reason,
    updatedAt: input.capturedAt,
  }
}

export function inferAgentStatus(input: AgentStatusInput): AgentStatus {
  // Same precedence as process inference: explicit command, then Claude Code's
  // version-named process with its title marker, then title/output mentions.
  const commandEvidence = inferAgentProvider(input.command, '', '')
  const providerEvidence = commandEvidence.provider !== 'unknown'
    ? commandEvidence
    : claudeVersionProcessEvidence(input.command, input.title)
      ?? inferAgentProvider(input.command, input.title, input.content)
  const provider = providerEvidence.provider
  const label = provider === 'unknown' ? 'Agent' : provider
  const tail = input.content.slice(-16_000)
  const recentLines = tail.split(/\r?\n/).slice(-50).join('\n')
  const unchangedFor = Math.max(0, input.capturedAt - input.lastChangedAt)
  const hasActiveIndicator = /(?:esc (?:to )?interrupt|ctrl-c to stop|thinking(?:\.{3}|…)|working(?:\.{3}|…)|generating(?:\.{3}|…))/i.test(
    recentLines,
  )
  const hasIdleOpenCodeComposer = provider === 'opencode' &&
    !hasActiveIndicator &&
    /\bOpenCode\s+\d+\.\d+(?:\.\d+)?\s*$/m.test(recentLines)

  if (input.dead) {
    return result(
      input,
      provider,
      'failed',
      `${label} process exited`,
      'process',
      'high',
      'tmux reports the pane process as dead',
    )
  }

  if (
    /(?:fatal error|uncaught (?:exception|error)|command failed|exited with (?:code|status) [1-9]|api error|rate limit exceeded)/i.test(
      recentLines,
    )
  ) {
    return result(
      input,
      provider,
      'failed',
      `${label} reported a failure`,
      'heuristic',
      'medium',
      'recent output contains an explicit failure marker',
    )
  }

  if (
    /(?:do you want to (?:proceed|continue)|would you like to|press enter to continue|allow .+\?|approve .+\?|\[(?:y\/n|Y\/n|y\/N)\]\s*$)/im.test(
      recentLines,
    ) ||
    /waiting for (?:your )?(?:answer|input|response)/i.test(recentLines)
  ) {
    return result(
      input,
      provider,
      'needs_input',
      `${label} is waiting for input`,
      'heuristic',
      'high',
      'recent output contains a confirmation or input prompt',
    )
  }

  if (hasActiveIndicator) {
    return result(
      input,
      provider,
      'working',
      `${label} is working`,
      'heuristic',
      'high',
      'recent output contains an active-work indicator',
    )
  }

  if (
    /(?:^|\n)\s*(?:❯|›)\s*$/.test(recentLines) ||
    /(?:^|\n)\s*(?:task )?(?:done|completed successfully)\.?\s*$/i.test(
      recentLines,
    ) ||
    hasIdleOpenCodeComposer
  ) {
    return result(
      input,
      provider,
      'done',
      `${label} is idle`,
      'heuristic',
      hasIdleOpenCodeComposer ? 'high' : 'medium',
      hasIdleOpenCodeComposer
        ? 'OpenCode composer shows no active work'
        : 'recent output ends at an agent prompt or completion marker',
    )
  }

  if (provider !== 'unknown' && unchangedFor >= 30_000) {
    return result(
      input,
      provider,
      'stale',
      `${label} has not produced output recently`,
      'process',
      'low',
      `pane output has been unchanged for ${Math.floor(unchangedFor / 1000)} seconds`,
    )
  }

  if (provider !== 'unknown' && unchangedFor < 2_000) {
    return result(
      input,
      provider,
      'working',
      `${label} is producing output`,
      'process',
      'low',
      'a supported agent produced output recently',
    )
  }

  return result(
    input,
    provider,
    'unknown',
    provider === 'unknown' ? 'No supported agent detected' : `${label} state is unclear`,
    providerEvidence.source,
    'low',
    providerEvidence.reason,
  )
}
