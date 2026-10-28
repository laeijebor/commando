import { fireEvent, screen } from '@testing-library/react'
import { expect } from 'vitest'
import type { StartWith } from './newSessionAgents'

const AGENT_LABELS: Record<StartWith, string> = {
  'claude-chat': 'Claude chat', 'codex-chat': 'Codex chat', 'muse-chat': 'Muse chat', 'cursor-chat': 'Cursor chat',
  claude: 'Claude terminal', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', shell: 'Shell', none: 'Nothing',
}

/** The New session form's Agent pill. */
export function agentPill(): HTMLElement {
  return screen.getByRole('button', { name: /^Agent:/ })
}

/** Picks what the session starts with from the Agent menu; Claude rows may name a profile. */
export function chooseAgent(provider: StartWith, profile?: string): void {
  fireEvent.click(agentPill())
  const label = `${AGENT_LABELS[provider]}${profile ? ` · ${profile}` : ''}`
  fireEvent.click(screen.getByRole('menuitemradio', { name: (name) => name === label || (!profile && name.startsWith(`${label} · `)) }))
}

export function expectAgent(provider: StartWith, profile?: string): void {
  expect(agentPill()).toHaveAccessibleName(`Agent: ${AGENT_LABELS[provider]}${profile ? ` (${profile})` : ''}`)
}

export function permissionPill(): HTMLElement {
  return screen.getByRole('button', { name: /^Permissions:/ })
}

/** Opens a pill's menu and returns its options' labels, ticked ones marked with `*`. */
export function menuLabels(pill: HTMLElement): string[] {
  fireEvent.click(pill)
  const labels = screen.getAllByRole('menuitemradio').map((item) => `${item.getAttribute('aria-checked') === 'true' ? '*' : ''}${item.textContent ?? ''}`)
  fireEvent.click(pill)
  return labels
}

export function choosePermission(label: string): void {
  fireEvent.click(permissionPill())
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
}

/** Unfolds the directory / worktree / window fields, which start folded away. */
export function openWorkspace(root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLElement>('[aria-controls^="tmux-create-workspace"]')
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}
