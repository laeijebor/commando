import { describe, expect, it } from 'vitest'
import {
  shellQuote,
  buildChatResumeCommand,
  buildChatReturnCommand as chatReturnCommand,
  findChatHost,
  buildResumeCommand,
  findAgentProcess,
  isChatResumeCommand,
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

describe('isChatResumeCommand', () => {
  it.each(['claude', 'codex'] as const)('recognises %s resume and return commands from the builders, with or without an environment prefix', (provider) => {
    const environments: Record<string, string>[] = [{}, { COMMANDO_PORT: '4410', COMMANDO_SOCKET: "/tmp/O'Brien/commando socket" }]
    for (const launcher of ['/c/scripts/commando-agent', "/checkout with spaces/O'Brien/scripts/commando-agent"]) {
      for (const daemonEnv of environments) {
        const flags = ['--permission-mode', 'plan', '--model', 'custom model']
        const commands = [
          buildChatResumeCommand(SESSION, launcher, {
            args: ['node', '/c/server/agent-host/main.ts', provider, ...flags],
            env: provider === 'claude' ? { CLAUDE_CONFIG_DIR: "/Users/me/Claude's profile" } : {},
          }, daemonEnv),
          chatReturnCommand(SESSION, launcher, flags, daemonEnv, provider),
        ]
        for (const command of commands) {
          expect(command).not.toBeNull()
          expect(isChatResumeCommand(command!)).toBe(true)
          // Saved commands may also quote plain words such as the provider.
          expect(isChatResumeCommand(command!.replace(` ${provider} `, ` '${provider}' `))).toBe(true)
          expect(isChatResumeCommand(command!.replace(` ${provider} `, ` "${provider}" `))).toBe(true)
        }
      }
    }
  })

  it.each(['claude', 'codex'] as const)('does not mistake a %s TUI command for a chat', (provider) => {
    const command = buildResumeCommand(provider, SESSION, { args: [provider], env: {} })
    expect(command).not.toBeNull()
    expect(isChatResumeCommand(command!)).toBe(false)
    expect(isChatResumeCommand(`${provider} --resume ${SESSION}`)).toBe(false)
  })

  it.each([
    `echo ${shellQuote(`/c/scripts/commando-agent claude --resume ${SESSION}`)}`,
    `claude --append-system-prompt ${shellQuote('/c/scripts/commando-agent codex')} --resume ${SESSION}`,
    `env ${shellQuote('NOTE=/c/scripts/commando-agent claude')} echo hello`,
    `/c/scripts/commando-agent-helper claude --resume ${SESSION}`,
    `/c/scripts/commando-agent cursor --resume ${SESSION}`,
    "/c/scripts/commando-agent 'claude",
    '',
  ])('rejects a launcher mentioned only in an argument, a different executable or malformed command: %s', (command) => {
    expect(isChatResumeCommand(command)).toBe(false)
  })

  it.each(['$COMMANDO_CHAT_RESUME', '${COMMANDO_CHAT_RESUME}'])('recognises the saved chat placeholder %s', (command) => {
    expect(isChatResumeCommand(command)).toBe(true)
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
    // Commando launches a new session's agent as the pane process itself.
    expect(findAgentProcess(table, 740, 'claude')?.pid).toBe(740)
    expect(findAgentProcess(table, 65922, 'codex')).toBeNull()
    expect(findAgentProcess(table, 741, 'claude')).toBeNull()
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

describe('chat hosts', () => {
  const host = 'node --import /c/node_modules/tsx/dist/loader.mjs /c/server/agent-host/main.ts claude --permission-mode default --resume 11111111-2222 --prompt hello world --model opus'

  it('finds the host as the pane process or a child of the launcher', () => {
    expect(findChatHost(parseProcessTable(`  9   1 ${host}`), 9)?.pid).toBe(9)
    expect(findChatHost(parseProcessTable(`  9   1 bash /c/scripts/commando-agent claude\n 10   9 ${host}`), 9)?.pid).toBe(10)
    expect(findChatHost(parseProcessTable('  9   1 /bin/zsh\n 10   9 claude --resume x'), 9)).toBeNull()
  })

  it('carries session flags, drops the old resume target and prompt, and reads the profile from the environment', () => {
    const command = buildChatResumeCommand('abcdef12-3456', '/c/scripts/commando-agent', { args: host.split(' '), env: { CLAUDE_CONFIG_DIR: '/Users/me/.claudep' } })
    // Flags after the prompt are lost because ps cannot tell prompt words from arguments.
    expect(command).toBe('/c/scripts/commando-agent claude --config-dir /Users/me/.claudep --permission-mode default --resume abcdef12-3456')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args: ['node', 'other.js'], env: {} })).toBeNull()
    expect(buildChatResumeCommand('$(bad)', '/c/launcher', { args: host.split(' '), env: {} })).toBeNull()
  })

  it("keeps a chat's stashed plan folder when tmux auto-resumes it", () => {
    const dir = `/state/chat-plans/${'d'.repeat(32)}`
    const planHost = `node /c/server/agent-host/main.ts claude --permission-mode acceptEdits --readable-dir ${dir} --prompt PLEASE IMPLEMENT THE PLAN`
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args: planHost.split(' '), env: {} }))
      .toBe(`/c/launcher claude --permission-mode acceptEdits --readable-dir ${dir} --resume abcdef12-3456`)
  })
})

describe('chat resume hardening', () => {
  it('never carries flag-looking words from the prompt', () => {
    const args = 'node --import /c/l.mjs /c/server/agent-host/main.ts claude --config-dir /u/.claudep --permission-mode default --prompt Use --dangerously-skip-permissions --model x'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/scripts/commando-agent', { args, env: {} }))
      .toBe('/c/scripts/commando-agent claude --config-dir /u/.claudep --permission-mode default --resume abcdef12-3456')
  })

  it('replaces the launch model, effort and permission flags with the chat\'s current settings', () => {
    const args = 'node /c/server/agent-host/main.ts claude --config-dir /u/.claudew --model haiku --effort low --dangerously-skip-permissions --claude-path /bin/claude'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }, {}, { model: 'sonnet', effort: 'high', permissionMode: 'plan', bypassAllowed: true }))
      .toBe('/c/launcher claude --config-dir /u/.claudew --claude-path /bin/claude --model sonnet --effort high --permission-mode plan --allow-dangerously-skip-permissions --resume abcdef12-3456')
    // The default model is no explicit model; a chat without bypass never gains it.
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args: 'node /c/server/agent-host/main.ts claude --model=haiku --permission-mode default'.split(' '), env: {} }, {}, { permissionMode: 'acceptEdits' }))
      .toBe('/c/launcher claude --permission-mode acceptEdits --resume abcdef12-3456')
  })

  it("carries the mode a plan-mode chat returns to on Implement, and drops a stale one", () => {
    const args = 'node /c/server/agent-host/main.ts claude --permission-mode plan --pre-plan-permission-mode default'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }))
      .toBe('/c/launcher claude --permission-mode plan --pre-plan-permission-mode default --resume abcdef12-3456')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }, {}, { permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits' }))
      .toBe('/c/launcher claude --permission-mode plan --pre-plan-permission-mode acceptEdits --resume abcdef12-3456')
    // Out of plan mode there is nothing to return to.
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }, {}, { permissionMode: 'acceptEdits', prePlanPermissionMode: 'acceptEdits' }))
      .toBe('/c/launcher claude --permission-mode acceptEdits --resume abcdef12-3456')
  })

  it('prefixes the daemon environment a restored shell may lack', () => {
    const args = 'node /c/server/agent-host/main.ts claude --permission-mode plan'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }, { COMMANDO_PORT: '4410' }))
      .toBe('env COMMANDO_PORT=4410 /c/launcher claude --permission-mode plan --resume abcdef12-3456')
  })

  it('quotes words zsh would expand', () => {
    expect(shellQuote('~root/x')).toBe("'~root/x'")
    expect(shellQuote('=ls')).toBe("'=ls'")
    expect(shellQuote('/plain/path')).toBe('/plain/path')
  })
})

describe('buildChatReturnCommand', () => {
  it("resumes the chat with only a chat host's own flags", () => {
    expect(chatReturnCommand('abcd1234-0000', '/c/scripts/commando-agent', ['--config-dir', '/Users/me/.claudep', '--model', 'sonnet', '--permission-mode', 'plan', '--pre-plan-permission-mode', 'acceptEdits', '--evil', '--prompt', 'x'], { COMMANDO_PORT: '4422' }))
      .toBe("env COMMANDO_PORT=4422 /c/scripts/commando-agent claude --config-dir /Users/me/.claudep --model sonnet --permission-mode plan --pre-plan-permission-mode acceptEdits --resume abcd1234-0000 --from-claude-code")
    expect(chatReturnCommand('bad id!', '/c/scripts/commando-agent', [])).toBeNull()
  })
})

describe('Codex chat resume and return', () => {
  it('carries the captured Codex home alongside the daemon environment on chat resume', () => {
    const args = 'node /c/server/agent-host/main.ts codex --permission-mode default'
    const launch = launchFromProcess('codex', args, `${args} CODEX_HOME=/Users/dev/.codex-work`)
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', launch, { COMMANDO_PORT: '4410' }))
      .toBe('env COMMANDO_PORT=4410 CODEX_HOME=/Users/dev/.codex-work /c/launcher codex --permission-mode default --resume abcdef12-3456')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { ...launch, env: { CODEX_HOME: '/Users/dev/Codex work' } }))
      .toBe("env 'CODEX_HOME=/Users/dev/Codex work' /c/launcher codex --permission-mode default --resume abcdef12-3456")
  })

  it('keeps Claude chat resume byte-identical when CODEX_HOME is present', () => {
    const args = 'node /c/server/agent-host/main.ts claude --permission-mode default'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', {
      args, env: { CODEX_HOME: '/Users/dev/.codex-work', CLAUDE_CONFIG_DIR: '/Users/dev/.claudep' },
    }, { COMMANDO_PORT: '4410' }))
      .toBe('env COMMANDO_PORT=4410 /c/launcher claude --config-dir /Users/dev/.claudep --permission-mode default --resume abcdef12-3456')
  })

  it('carries fast mode only while the chat still has it on', () => {
    const args = 'node /c/server/agent-host/main.ts codex --model gpt-6.1-sol --fast --permission-mode default'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }))
      .toBe('/c/launcher codex --model gpt-6.1-sol --fast --permission-mode default --resume abcdef12-3456')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: {} }, {}, { model: 'gpt-6.1-sol', permissionMode: 'default' }))
      .toBe('/c/launcher codex --model gpt-6.1-sol --permission-mode default --resume abcdef12-3456')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args: args.filter((arg) => arg !== '--fast'), env: {} }, {}, { model: 'gpt-6.1-sol', fast: true, permissionMode: 'default' }))
      .toBe('/c/launcher codex --model gpt-6.1-sol --fast --permission-mode default --resume abcdef12-3456')
  })

  it('preserves Codex model/effort, never inheriting a Claude config directory', () => {
    const args = 'node /c/server/agent-host/main.ts codex --model test-model --effort high --permission-mode default --prompt hi --model wrong'.split(' ')
    expect(buildChatResumeCommand('abcdef12-3456', '/c/launcher', { args, env: { CLAUDE_CONFIG_DIR: '/Users/dev/.claudep' } }))
      .toBe('/c/launcher codex --model test-model --effort high --permission-mode default --resume abcdef12-3456')
    expect(chatReturnCommand('abcdef12-3456', '/c/launcher', ['--permission-mode', 'plan'], {}, 'codex'))
      .toBe('/c/launcher codex --permission-mode plan --resume abcdef12-3456 --from-claude-code')
  })
})
