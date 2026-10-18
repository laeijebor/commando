import { describe, expect, it } from 'vitest'
import { chatPermissionModes, sanitizeBranchName, sessionAgentArgv } from './tmux-create.js'

describe('interactive agent arguments', () => {
  it.each([['claude', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['cursor', 'agent']] as const)('maps %s to its actual CLI', (provider, command) => {
    expect(sessionAgentArgv({ provider })).toEqual([command])
  })
  it.each(['update', 'install', 'mcp', 'login', 'auth', 'exec', '--force'])('keeps the collision prompt %j out of all providers command parsers', (prompt) => {
    const claude = sessionAgentArgv({ provider: 'claude', prompt })
    // Exact matcher extracted and safely evaluated from installed Claude 2.1.292.
    const commands = ['update', 'upgrade', 'install', 'mcp', 'auth', 'doctor']
    const findClaudeCommand = (operand: string) => commands.find((name) => name === operand)
    expect(claude.slice(1)).toEqual(['--', ` ${prompt}`])
    expect(findClaudeCommand(claude[2])).toBeUndefined()
    expect(claude[2].trimStart()).toBe(prompt)
    expect(sessionAgentArgv({ provider: 'codex', prompt })).toEqual(['codex', '--', prompt])
    expect(sessionAgentArgv({ provider: 'cursor', prompt })).toEqual(['agent', 'agent', '--', prompt])
    expect(sessionAgentArgv({ provider: 'opencode', prompt })).toEqual(['opencode', `--prompt=${prompt}`])
  })
  it('treats command-like and flag-like prompts as literal data and preserves newlines', () => {
    expect(sessionAgentArgv({ provider: 'cursor', prompt: 'login' })).toEqual(['agent', 'agent', '--', 'login'])
    expect(sessionAgentArgv({ provider: 'cursor', prompt: '--force\nsecond line' })).toEqual(['agent', 'agent', '--', '--force\nsecond line'])
    expect(sessionAgentArgv({ provider: 'claude', prompt: 'Fix' })).toEqual(['claude', '--', ' Fix'])
    expect(sessionAgentArgv({ provider: 'codex', prompt: 'Fix' })).toEqual(['codex', '--', 'Fix'])
    expect(sessionAgentArgv({ provider: 'opencode', prompt: 'Fix' })).toEqual(['opencode', '--prompt=Fix'])
  })
})

describe('sanitizeBranchName', () => {
  it('lowercases and joins words with dashes', () => {
    expect(sanitizeBranchName('Bot admission click cooldown')).toBe('bot-admission-click-cooldown')
  })

  it('turns slashes, ampersands and plus signs into dashes and collapses runs', () => {
    expect(sanitizeBranchName('Sam / U Fit updates')).toBe('sam-u-fit-updates')
    expect(sanitizeBranchName('Seeded Demo & Doc Generation')).toBe('seeded-demo-doc-generation')
    expect(sanitizeBranchName('leo+help-kit-p1')).toBe('leo-help-kit-p1')
  })

  it('keeps dots, digits and existing dashes', () => {
    expect(sanitizeBranchName('vv-verify686')).toBe('vv-verify686')
    expect(sanitizeBranchName('release 1.2.3')).toBe('release-1.2.3')
  })

  it('drops characters git refs cannot contain and trims leading or trailing separators', () => {
    expect(sanitizeBranchName('  ~^:?*[fix] "quotes"  ')).toBe('fix-quotes')
    expect(sanitizeBranchName('---dashes---')).toBe('dashes')
    expect(sanitizeBranchName('.hidden.')).toBe('hidden')
  })

  it('never produces a double dot or a .lock suffix', () => {
    expect(sanitizeBranchName('a..b')).toBe('a.b')
    expect(sanitizeBranchName('index.lock')).toBe('index')
  })

  it('caps the result at 64 characters without a trailing dash', () => {
    const long = 'word '.repeat(30)
    const result = sanitizeBranchName(long)
    expect(result.length).toBeLessThanOrEqual(64)
    expect(result.endsWith('-')).toBe(false)
  })

  it('returns an empty string when nothing survives', () => {
    expect(sanitizeBranchName('???')).toBe('')
    expect(sanitizeBranchName('')).toBe('')
  })
})

describe('defaultWorktreePath', () => {
  it('places the worktree in a sibling <repo>-worktrees folder next to the main checkout', async () => {
    const { defaultWorktreePath } = await import('./tmux-create.js')
    expect(defaultWorktreePath('/Users/leo/dev/gizmo/Save-All', 'bot-rematch-flow'))
      .toBe('/Users/leo/dev/gizmo/Save-All-worktrees/bot-rematch-flow')
  })

  it('tolerates a trailing slash on the main checkout', async () => {
    const { defaultWorktreePath } = await import('./tmux-create.js')
    expect(defaultWorktreePath('/Users/leo/vivifit/', 'chat-video')).toBe('/Users/leo/vivifit-worktrees/chat-video')
  })
})

describe('chat launch arguments', () => {
  it('passes a stashed plan folder before the prompt, which the host reads to the end', () => {
    const dir = `/home/me/.commando/chat-plans/${'e'.repeat(32)}`
    expect(sessionAgentArgv({ provider: 'claude-chat', permissionMode: 'acceptEdits', readableDir: dir, prompt: 'PLEASE IMPLEMENT --now' })).toEqual([
      'commando-agent', 'claude', '--permission-mode', 'acceptEdits', '--readable-dir', dir, '--prompt', 'PLEASE IMPLEMENT --now',
    ])
  })
})

describe('Codex chat launch', () => {
  it('launches the host with Codex and literal prompt text, without Claude flags', () => {
    expect(sessionAgentArgv({ provider: 'codex-chat', permissionMode: 'plan', prompt: '--model malicious\nhello' }))
      .toEqual(['commando-agent', 'codex', '--permission-mode', 'plan', '--prompt', '--model malicious\nhello'])
    expect(sessionAgentArgv({ provider: 'codex-chat', configDir: '/unused/.claude', readableDir: '/unused' }))
      .toEqual(['commando-agent', 'codex', '--permission-mode', 'default'])
  })
})

describe('Muse chat launch', () => {
  it('launches the host with Muse, its resume target and literal prompt text', () => {
    expect(sessionAgentArgv({ provider: 'muse-chat', permissionMode: 'bypassPermissions', resume: '01a14dc2-082e-7781-9892-8b5bc1fea332', prompt: 'hi' }))
      .toEqual(['commando-agent', 'muse', '--permission-mode', 'bypassPermissions', '--resume', '01a14dc2-082e-7781-9892-8b5bc1fea332', '--prompt', 'hi'])
    expect(chatPermissionModes('muse-chat').map((mode) => mode.value)).toEqual(['default', 'bypassPermissions'])
  })
})

describe('Cursor chat launch arguments', () => {
  it('defaults to full access without carrying Claude directories', () => {
    expect(sessionAgentArgv({ provider: 'cursor-chat', configDir: '/unused', readableDir: '/unused' }))
      .toEqual(['commando-agent', 'cursor', '--permission-mode', 'bypassPermissions'])
  })
  it('places resume before arbitrary prompt data', () => {
    expect(sessionAgentArgv({ provider: 'cursor-chat', permissionMode: 'auto', resume: 'agent-12345678-0000', prompt: '--model injected\nhello' }))
      .toEqual(['commando-agent', 'cursor', '--permission-mode', 'auto', '--resume', 'agent-12345678-0000', '--prompt', '--model injected\nhello'])
  })
})
