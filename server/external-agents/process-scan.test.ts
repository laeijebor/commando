import { describe, expect, it, vi } from 'vitest'
import { findAgentProcesses, indexProcesses, parseProcesses, recognizeAgent, runningCommand, type ProcessRow } from './process-scan.js'

export const processRow = (pid: number, ppid: number, command: string, startedAt = 1_000, pgid = pid, tty = '??'): ProcessRow => ({ pid, ppid, command, startedAt, pgid, tty })
const ancestry = [processRow(10, 1, '/bin/zsh'), processRow(20, 10, 'node commando-agent claude'), processRow(30, 20, '/Users/test/.local/bin/claude -p --input-format stream-json'), processRow(40, 30, '/bin/bash -c launch')]

describe('external process detection', () => {
  it.each([
    ['codex exec "Review the tests"', 'codex'],
    ['node /opt/bin/codex.js exec resume 00000000-0000-4000-8000-000000000001', 'codex'],
    ['/Users/test/.local/bin/claude --print "Review tests"', 'claude'],
    ['claude -p "Review tests"', 'claude'],
    ['opencode run --model provider/model "Review tests"', 'opencode'],
    ['agent -p --model model "Review tests"', 'cursor'],
    ['/opt/bin/cursor-agent --print "Review tests"', 'cursor'],
  ])('recognizes %s', (command, runtime) => {
    expect(recognizeAgent(command)?.runtime).toBe(runtime)
  })

  it.each(['codex', 'codex resume id', 'claude', 'opencode', 'agent', 'claude -p --input-format stream-json', 'claude --print --input-format=stream-json', 'bash -c "codex exec prompt"', 'echo codex exec prompt'])('excludes %s', (command) => {
    expect(recognizeAgent(command)).toBeNull()
  })

  it('requires a shell below the chat host, excludes SDK and interactive agents, and keeps the topmost wrapper', () => {
    const rows = [...ancestry,
      processRow(50, 40, 'node /opt/bin/codex.js exec "Review tests"'),
      processRow(51, 50, '/opt/native/codex exec "Review tests"'),
      processRow(52, 51, '/bin/sh -c npm test'), processRow(53, 52, 'npm test', 5_000),
      processRow(60, 20, 'claude -p "SDK child without stream flags"'),
      processRow(70, 10, 'codex exec "Outside host"'),
      processRow(80, 40, 'claude -p "External Claude"'),
    ]
    const runs = findAgentProcesses(rows, 10, 20)
    expect(runs.map((run) => run.pid)).toEqual([50, 80])
    expect(runningCommand(rows, runs[0]!)).toEqual({ command: 'npm test', startedAt: 1_000 })
    expect(findAgentProcesses(rows, 999, 20)).toEqual([])
    expect(runningCommand(rows.filter((row) => ![52, 53].includes(row.pid)), runs[0]!)).toBeUndefined()
  })

  it('ignores long-lived MCP and code-mode helpers and reports the actual tool shell', () => {
    const rows = [...ancestry,
      processRow(50, 40, 'codex exec prompt'),
      processRow(48423, 50, 'node /opt/bin/argent mcp', 2_000),
      processRow(51019, 50, '/opt/bin/codex-code-mode-host', 3_000),
      processRow(51331, 51019, '/bin/zsh -c sleep 45 && cat a.txt b.txt', 4_000),
    ]
    const run = findAgentProcesses(rows, 10, 20)[0]!
    expect(runningCommand(rows, run)).toEqual({ command: 'sleep 45 && cat a.txt b.txt', startedAt: 4_000 })
    expect(runningCommand(rows.filter((row) => row.pid !== 51331), run)).toBeUndefined()
  })

  it.each([['sh', '-c'], ['bash', '-lc'], ['zsh', '-lic']])('uses the outermost %s %s command and its start time', (shell, flag) => {
    const rows = [...ancestry,
      processRow(50, 40, 'codex exec prompt'),
      processRow(51, 50, `/bin/${shell} ${flag} "sleep 45 && cat a.txt b.txt"`, 2_000),
      processRow(52, 51, '/bin/sh -c sleep 45', 3_000),
      processRow(53, 52, 'sleep 45', 4_000),
    ]
    const run = findAgentProcesses(rows, 10, 20)[0]!
    expect(runningCommand(rows, run)).toEqual({ command: 'sleep 45 && cat a.txt b.txt', startedAt: 2_000 })
  })

  it('unwraps the command from a Claude Code Bash preamble', () => {
    const wrapped = `/bin/zsh -c source /Users/test/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'npm test -- --grep '\\''quiet'\\''' < /dev/null && pwd -P >| /tmp/claude-1-cwd`
    const rows = [...ancestry, processRow(50, 40, 'claude -p "Review tests"'), processRow(51, 50, wrapped, 2_000)]
    expect(runningCommand(rows, findAgentProcesses(rows, 10, 20)[0]!)).toEqual({ command: `npm test -- --grep 'quiet'`, startedAt: 2_000 })
  })

  it('ignores shells without a command flag', () => {
    const rows = [...ancestry, processRow(50, 40, 'codex exec prompt'), processRow(51, 50, '/bin/bash helper.sh'), processRow(52, 51, 'node /opt/bin/argent mcp')]
    expect(runningCommand(rows, findAgentProcesses(rows, 10, 20)[0]!)).toBeUndefined()
  })

  it.each(['node', 'nodejs', 'bun', 'deno', 'npm', 'npx', 'pnpm', 'yarn', 'uv', 'uvx', 'python', 'python3.12'])('ignores MCP shells launched through %s', (interpreter) => {
    const rows = [...ancestry, processRow(50, 40, 'codex exec prompt'), processRow(51, 50, `${interpreter} /opt/bin/argent mcp`), processRow(52, 51, '/bin/sh -c argent mcp')]
    expect(runningCommand(rows, findAgentProcesses(rows, 10, 20)[0]!)).toBeUndefined()
  })

  it('recognizes each row once before filtering the same index for different panes', () => {
    const rows = [...ancestry, processRow(50, 40, 'codex exec prompt')]
    const recognize = vi.fn(recognizeAgent)
    const index = indexProcesses(rows, recognize)
    expect(findAgentProcesses(rows, 10, 20, index).map((run) => run.pid)).toEqual([50])
    expect(findAgentProcesses(rows, 30, 30, index).map((run) => run.pid)).toEqual([50])
    expect(recognize).toHaveBeenCalledTimes(rows.length)
  })

  it('extracts prompts for transcript matching without treating stdin as a prompt', () => {
    expect(recognizeAgent('codex exec --sandbox read-only -m model -c model_reasoning_effort=high --output-last-message /tmp/result.txt "Review the parser carefully"')?.prompt).toBe('Review the parser carefully')
    expect(recognizeAgent('claude -p --model sonnet --settings /tmp/settings.json "Review the scanner carefully"')?.prompt).toBe('Review the scanner carefully')
    expect(recognizeAgent('codex exec -')?.prompt).toBeUndefined()
    expect(recognizeAgent('claude -p')?.prompt).toBeUndefined()
  })

  it.each(['--resume', '-r', '--session-id', '--resume=', '-r=', '--session-id='])('parses Claude explicit session flag %s', (flag) => {
    const id = '00000000-0000-4000-8000-000000000001'
    const option = flag.endsWith('=') ? `${flag}${id}` : `${flag} ${id}`
    expect(recognizeAgent(`claude -p ${option} "Review new changes"`)).toMatchObject({ runtime: 'claude', resume: true, resumeId: id, prompt: 'Review new changes' })
  })

  it.each(['-c', '--continue'])('parses Claude continuation %s', (flag) => {
    expect(recognizeAgent(`claude ${flag} -p "Review new changes"`)).toMatchObject({ resume: true, prompt: 'Review new changes' })
    expect(recognizeAgent(`claude ${flag} -p "Review new changes"`)?.resumeId).toBeUndefined()
  })

  it.each(['--resume old-session', '-r old-session', '--session-id old-session', '-c', '--continue'])('treats Claude --fork-session with %s as a new transcript', (flags) => {
    const agent = recognizeAgent(`claude -p ${flags} --fork-session "Review new changes"`)
    expect(agent).toMatchObject({ resume: false, prompt: 'Review new changes' })
    expect(agent?.resumeId).toBeUndefined()
  })

  it('handles cycles without claiming unrelated processes', () => {
    const rows = [...ancestry, processRow(90, 91, 'codex exec prompt'), processRow(91, 90, '/bin/bash')]
    expect(findAgentProcesses(rows, 10, 20)).toEqual([])
  })

  it('extracts only the prompt and skips CLI option values', () => {
    expect(recognizeAgent('agent --model model -p "Review the change\nSecond line"')?.label).toBe('Review the change')
    expect(recognizeAgent('opencode run -m provider/model "Review the change"')?.label).toBe('Review the change')
    expect(recognizeAgent('agent -p')?.label).toBe('Cursor agent')
    expect(recognizeAgent('codex exec resume 00000000-0000-4000-8000-000000000001')?.resumeId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it.each(['-C /tmp/x', '--cd /tmp/x', '-C=/tmp/x', '--cd=/tmp/x', '-C ../other'])('parses Codex cwd override %s', (flags) => {
    expect(recognizeAgent(`codex exec ${flags} "Review tests"`)?.cwdOverride).toBe(flags.includes('../other') ? '../other' : '/tmp/x')
  })

  it.each([
    '-m gpt-6.1-sol -c model_reasoning_effort=high',
    '--model gpt-6.1-sol -c model_reasoning_effort="high"',
    "--model=gpt-6.1-sol -c 'model_reasoning_effort=high'",
    "-m=gpt-6.1-sol --config='model_reasoning_effort=\"high\"'",
  ])('parses fallback Codex metadata from %s', (flags) => {
    expect(recognizeAgent(`codex exec ${flags} "Review tests"`)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
  })

  it('ignores unrelated Codex config and stops reading flags after --', () => {
    expect(recognizeAgent('codex exec -c other=value -- -C /tmp/x -m model')).toMatchObject({ runtime: 'codex', label: 'codex exec', resume: false, prompt: '-C /tmp/x -m model' })
  })

  it('reads one ps table with process start times, group ids and controlling terminals', () => {
    const rows = parseProcesses('  50 40 50 ?? Tue Oct 13 07:30:10 2026 node /opt/bin/codex.js exec prompt\n  60 1 60 ttys001 Tue Oct 13 07:30:10 2026 claude -p prompt\ngarbled\n')
    const startedAt = new Date('Tue Oct 13 07:30:10 2026').getTime()
    expect(rows).toEqual([processRow(50, 40, 'node /opt/bin/codex.js exec prompt', startedAt), processRow(60, 1, 'claude -p prompt', startedAt, 60, 'ttys001')])
  })
})
