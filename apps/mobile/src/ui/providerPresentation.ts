import type { Theme } from '../theme'

export type ProviderPresentation = { name: string; mark: string; accent: keyof Pick<Theme, 'accent' | 'cyan' | 'amber' | 'textSoft' | 'green' | 'muted'> }
const PROVIDERS: Record<string, ProviderPresentation> = {
  claude: { name: 'Claude', mark: 'CL', accent: 'accent' },
  codex: { name: 'Codex', mark: 'CX', accent: 'cyan' },
  cursor: { name: 'Cursor', mark: 'CU', accent: 'textSoft' },
  muse: { name: 'Muse', mark: 'MU', accent: 'green' },
  opencode: { name: 'OpenCode', mark: 'OC', accent: 'amber' },
}
export function providerPresentation(provider: string | undefined): ProviderPresentation {
  return provider && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider]! : { name: 'Agent', mark: 'AI', accent: 'muted' }
}
