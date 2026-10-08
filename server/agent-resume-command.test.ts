import { describe, expect, it } from 'vitest'
import {
  buildResumeCommand,
  findAgentProcess,
  isShellCommand,
  launchFromProcess,
  parseProcessTable,
} from './agent-resume-command.js'

const CLAUDE = '/Users/me/.local/bin/claude'
const SESSION = 'ba080dbd-899d-41d3-a94d-44032d806009'

describe('buildResumeCommand', () => {
  it('resumes Claude with its config dir and session-shaping flags', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: [CLAUDE, '--dangerously-skip-permissions', '--model', 'opus'],
      env: { CLAUDE_CONFIG_DIR: '/Users/me/.claudep' },
    })).toBe(`env CLAUDE_CONFIG_DIR=/Users/me/.claudep ${CLAUDE} --dangerously-skip-permissions --model opus --resume ${SESSION}`)
  })

  it('drops prompts, print mode and the previous resume target', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: [CLAUDE, '--resume', 'old-session-id', '--continue', '--verbose', '-p', 'fix', 'the', 'bug'],
      env: {},
    })).toBe(`${CLAUDE} --verbose --resume ${SESSION}`)
  })

  it('never turns words of a prompt into flags', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: [CLAUDE, '--model', 'opus', 'why', 'does', '--dangerously-skip-permissions', 'exist?'],
      env: {},
    })).toBe(`${CLAUDE} --model opus --resume ${SESSION}`)
  })

  it('keeps every value of a multi-value flag and inline values', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: [CLAUDE, '--add-dir', '/a', '/b', '--permission-mode=plan'],
      env: {},
    })).toBe(`${CLAUDE} --add-dir /a /b --permission-mode=plan --resume ${SESSION}`)
  })

  it('runs a bare executable through env so aliases cannot intercept it', () => {
    expect(buildResumeCommand('opencode', 'ses_efa555c98ffeKC32rXhcpzuipD', {
      args: ['opencode', '--yolo', '-s', 'ses_old000000000'],
      env: {},
    })).toBe('env opencode --yolo -s ses_efa555c98ffeKC32rXhcpzuipD')
  })

  it('puts Codex flags after the resume subcommand', () => {
    expect(buildResumeCommand('codex', '01a113c2-324e-7de3-a1f3-63092dd02078', {
      args: ['codex', '-m', 'gpt-6.1-sol', '--dangerously-bypass-approvals-and-sandbox', 'write tests'],
      env: { CODEX_HOME: '/Users/me/.codex' },
    })).toBe('env CODEX_HOME=/Users/me/.codex codex resume -m gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox 01a113c2-324e-7de3-a1f3-63092dd02078')
  })

  it('resumes Cursor through its launcher, not the bundled script', () => {
    expect(buildResumeCommand('cursor', 'chat-1234567', {
      args: ['/Users/me/.local/bin/agent', '--use-system-ca', '/Users/me/.local/share/cursor-agent/index.js', '--force'],
      env: {},
    })).toBe('/Users/me/.local/bin/agent --force --resume=chat-1234567')
  })

  it('accepts npm installs run under node', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: ['/usr/local/bin/node', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
      env: {},
    })).toBe(`/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${SESSION}`)
  })

  it('quotes values the shell would interpret', () => {
    expect(buildResumeCommand('claude', SESSION, {
      args: [CLAUDE, '--settings', '/tmp/$HOME;rm'],
      env: {},
    })).toBe(`${CLAUDE} --settings '/tmp/$HOME;rm' --resume ${SESSION}`)
  })

  it('refuses unknown executables and unsafe session ids', () => {
    expect(buildResumeCommand('claude', SESSION, { args: ['vim'], env: {} })).toBeNull()
    expect(buildResumeCommand('codex', 'codex:%3', { args: ['codex'], env: {} })).toBeNull()
    expect(buildResumeCommand('claude', 'id; rm -rf /', { args: [CLAUDE], env: {} })).toBeNull()
  })
})

describe('process helpers', () => {
  const table = parseProcessTable([
    '    1     0 /sbin/launchd',
    '  740 65922 /Users/me/.local/bin/claude --dangerously-skip-permissions',
    '  741   740 /bin/zsh -c npm test',
    '  800 65922 /usr/bin/caffeinate',
  ].join('\n'))

  it('finds the provider CLI among the pane shell children', () => {
    expect(findAgentProcess(table, 65922, 'claude')?.pid).toBe(740)
    expect(findAgentProcess(table, 65922, 'codex')).toBeNull()
    expect(findAgentProcess(table, 740, 'claude')).toBeNull()
  })

  it('reads only the provider variables from the process environment', () => {
    const args = '/Users/me/.local/bin/claude --dangerously-skip-permissions'
    const launch = launchFromProcess('claude', args, `${args} SECRET_TOKEN=abc CLAUDE_CONFIG_DIR=/Users/me/.claudep HOME=/Users/me\n`)
    expect(launch).toEqual({
      args: ['/Users/me/.local/bin/claude', '--dangerously-skip-permissions'],
      env: { CLAUDE_CONFIG_DIR: '/Users/me/.claudep' },
    })
  })

  it('treats login shells as shells and agent titles as running agents', () => {
    expect(isShellCommand('-zsh')).toBe(true)
    expect(isShellCommand('bash')).toBe(true)
    expect(isShellCommand('2.1.295')).toBe(false)
    expect(isShellCommand('opencode')).toBe(false)
  })
})
